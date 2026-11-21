// Git smart-HTTP: info/refs, upload-pack (v0 + v2), receive-pack (v0).
//
// The wire shape is checked line-by-line by the suite's own git client, so
// every packet here is built to match the client's parser: v2 advertisements
// start with `version 2`, v0 with `# service=...`, ls-refs answers carry
// `symref-target` and `peeled` attributes, fetch answers use the
// acknowledgments / shallow-info / packfile sections with sideband framing,
// and receive-pack reports `unpack ok` followed by one `ok`/`ng` line per
// command. A malformed receive-pack body is answered with an error status
// and never crashes the process.

import { readPack, writePack, pktLine, pktFlush, pktDelim, decodePackets, packetLines, ZERO_OID, isOid, parseCommit, parseTag, parseTree, type GitObject } from './gitobj.ts';
import { Store, DEFAULT_BRANCH, type Repo } from './store.ts';

const CAP_UPLOAD_V0 = 'symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack multi_ack shallow';
const CAP_RECEIVE_V0 = 'report-status side-band-64k delete-refs ofs-delta';

export type HandlerResult = { status: number; contentType: string; body: Buffer };

function result(status: number, contentType: string, body: Buffer | string): HandlerResult {
  return { status, contentType, body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body };
}

function sortedRefs(repo: Repo): Array<{ ref: string; oid: string }> {
  const out: Array<{ ref: string; oid: string }> = [];
  for (const [ref, oid] of repo.refs) out.push({ ref, oid });
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return out;
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
}

function refLineV0(repo: Repo, ref: string, oid: string, caps: string | null): string {
  let line = `${oid} ${ref}`;
  if (caps !== null) line += `\0${caps}`;
  return line;
}

/** v0 advertisement for both services, plus peeled tag lines. */
function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack' ? CAP_UPLOAD_V0 : CAP_RECEIVE_V0;
  const lines: Buffer[] = [pktLine(`# service=${service}`), pktFlush()];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    lines.push(pktLine(refLineV0(repo, 'HEAD', ZERO_OID, caps)));
  } else {
    lines.push(pktLine(refLineV0(repo, 'HEAD', head, caps)));
    for (const { ref, oid } of refs) lines.push(pktLine(`${oid} ${ref}`));
    for (const { ref, oid } of refs) {
      if (!ref.startsWith('refs/tags/')) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tag') continue;
      let target: string | null = null;
      try {
        target = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m)?.[1] ?? null;
      } catch {
        target = null;
      }
      if (target && isOid(target)) lines.push(pktLine(`${target} ${ref}^{}`));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  thinPack: boolean;
}

function collectCommits(store: Store, repo: Repo, roots: string[], limitDepth: number | null): { commits: string[]; depth: Map<string, number> } {
  // BFS by generation depth: root depth 0, parents +1. Stops before going
  // past `limitDepth` generations when set. Shallow sentinels are handled
  // by the caller trimming with `boundaryRoots`.
  const depth = new Map<string, number>();
  const commits: string[] = [];
  const queue: string[] = [];
  for (const r of roots) {
    const peeled = store.peelToCommit(repo, r);
    if (peeled && !depth.has(peeled)) {
      depth.set(peeled, 0);
      queue.push(peeled);
    }
  }
  while (queue.length) {
    const cur = queue.shift()!;
    commits.push(cur);
    const d = depth.get(cur)!;
    if (limitDepth !== null && d >= limitDepth) continue;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    let parents: string[] = [];
    try {
      parents = parseCommit(obj.data).parents;
    } catch {
      parents = [];
    }
    for (const p of parents) {
      if (!depth.has(p)) {
        depth.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  return { commits, depth };
}

/** Objects reachable from `included` commits without following parent commits outside the set: collectCommits already applied the depth limit, and a full reachable() walk would silently re-add the whole history (breaking shallow depth-1 clones). */
function reachableWithin(repo: Repo, included: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...included];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      try {
        queue.push(parseCommit(obj.data).tree);
      } catch {
        /* ignore */
      }
      // Parents deliberately NOT followed.
    } else if (obj.type === 'tag') {
      try {
        queue.push(parseTag(obj.data).object);
      } catch {
        /* ignore */
      }
    } else if (obj.type === 'tree') {
      try {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
      } catch {
        /* ignore */
      }
    }
  }
  return seen;
}

/** Objects the client already holds: closure of held commits, but never across a shallow boundary — a shallow tip's parent is NOT held, even though the client sent the tip as a have. */
function reachableHeld(repo: Repo, held: Set<string>, shallow: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...held];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      try {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        if (!shallow.has(oid)) for (const p of c.parents) queue.push(p);
      } catch {
        /* ignore */
      }
    } else if (obj.type === 'tag') {
      try {
        queue.push(parseTag(obj.data).object);
      } catch {
        /* ignore */
      }
    } else if (obj.type === 'tree') {
      try {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
      } catch {
        /* ignore */
      }
    }
  }
  return seen;
}

interface FetchSelection {
  objects: GitObject[];
  shallowOut: string[];
  unshallow: string[];
  ack: string | null;
}

/** The core fetch selection shared by v0 and v2 upload-pack. */
function selectFetch(store: Store, repo: Repo, plan: FetchPlan): FetchSelection {
  const heldRoots = new Set(plan.haves.map((h) => store.peelToCommit(repo, h)).filter((x): x is string => x !== null));
  const heldCommits = new Set<string>();
  {
    // Walk held commits but do not traverse past a shallow boundary.
    const boundary = new Set(plan.shallow);
    const queue = [...heldRoots];
    while (queue.length) {
      const cur = queue.pop()!;
      if (heldCommits.has(cur)) continue;
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      heldCommits.add(cur);
      if (boundary.has(cur)) continue;
      let parents: string[] = [];
      try {
        parents = parseCommit(obj.data).parents;
      } catch {
        parents = [];
      }
      for (const p of parents) queue.push(p);
    }
  }
  const limitDepth = plan.deepen !== null ? plan.deepen - 1 : null;
  const { commits: included, depth } = collectCommits(store, repo, plan.wants, limitDepth);
  // Shallow boundaries inside the included set: a commit whose parent was
  // not included (because of depth) or which the client sent as shallow.
  const includedSet = new Set(included);
  const shallowOut = new Set<string>();
  for (const c of included) {
    const obj = repo.objects.get(c);
    if (!obj || obj.type !== 'commit') {
      if (plan.shallow.includes(c)) shallowOut.add(c);
      continue;
    }
    let parents: string[] = [];
    try {
      parents = parseCommit(obj.data).parents;
    } catch {
      parents = [];
    }
    // A boundary remains only while some parent is missing: a previously
    // shallow commit whose parents are all included now is unshallowed
    // (the unshallow loop below reports it), not shallow again.
    const missingParent = parents.some((p) => !includedSet.has(p));
    if (plan.shallow.includes(c) ? parents.length === 0 || missingParent : missingParent) shallowOut.add(c);
  }
  const unshallow: string[] = [];
  for (const s of plan.shallow) {
    if (includedSet.has(s) && !shallowOut.has(s)) {
      // A shallow boundary whose parent is now included: it is unshallowed.
      const obj = repo.objects.get(s);
      if (obj && obj.type === 'commit') {
        let parents: string[] = [];
        try {
          parents = parseCommit(obj.data).parents;
        } catch {
          parents = [];
        }
        if (parents.length > 0 && parents.every((p) => includedSet.has(p))) unshallow.push(s);
      }
    }
  }
  void depth;
  const includedObjects = reachableWithin(repo, includedSet);
  const heldObjects = reachableHeld(repo, heldCommits, new Set(plan.shallow));
  // Tag objects peeled from a wanted tag oid travel with the pack.
  for (const w of plan.wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag') includedObjects.add(w);
  }
  const send: GitObject[] = [];
  const seen = new Set<string>();
  const ordered = [...includedObjects].sort();
  for (const oid of ordered) {
    if (heldObjects.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (seen.has(oid)) continue;
    seen.add(oid);
    send.push(obj);
  }
  // ACK: the client expects the first have that is an ancestor-or-equal of
  // a want. All wants are satisfied by the first shared commit, if any.
  let ack: string | null = null;
  for (const h of plan.haves) {
    const peeled = store.peelToCommit(repo, h);
    if (peeled && includedSet.has(peeled)) {
      ack = peeled;
      break;
    }
  }
  return { objects: send, shallowOut: [...shallowOut].sort(), unshallow, ack };
}

function sidebandPack(objects: GitObject[]): Buffer {
  const pack = writePack(objects);
  const out: Buffer[] = [];
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65515));
    const frame = Buffer.alloc(chunk.length + 1);
    frame[0] = 1;
    chunk.copy(frame, 1);
    out.push(pktLine(frame));
    off += chunk.length;
  }
  return Buffer.concat(out);
}

// ------------------------------------------------------------ info/refs

export function infoRefs(store: Store, owner: string, repoName: string, service: string | null, isV2: boolean): HandlerResult {
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    return result(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
  }
  if (service === 'git-receive-pack') {
    return result(200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
  }
  if (service === 'git-upload-pack') {
    if (isV2) {
      const lines: Buffer[] = [
        pktLine('version 2'),
        pktLine('ls-refs=unborn'),
        pktLine('fetch=shallow filter'),
        pktLine('object-format=sha1'),
        pktLine('agent=forge/1.0'),
        pktFlush(),
      ];
      return result(200, 'application/x-git-upload-pack-advertisement', Buffer.concat(lines));
    }
    return result(200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
  }
  return result(400, 'application/json', JSON.stringify({ message: 'missing service parameter' }));
}

// ------------------------------------------------------------ upload-pack

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes: string[] = [];
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (wantUnborn) lines.push(pktLine('unborn HEAD symref-target:refs/heads/main'));
  } else {
    if (matches('HEAD')) {
      let line = `${head} HEAD`;
      if (wantSymrefs) line += ' symref-target:refs/heads/main';
      lines.push(pktLine(line));
    }
    for (const { ref, oid } of refs) {
      if (!matches(ref)) continue;
      let line = `${oid} ${ref}`;
      if (wantPeel && ref.startsWith('refs/tags/')) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const target = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m)?.[1];
          if (target) line += ` peeled:${target}`;
        }
      }
      lines.push(pktLine(line));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function parseFetchArgs(args: string[]): FetchPlan {
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], deepen: null, thinPack: false };
  for (const a of args) {
    if (a.startsWith('want ')) plan.wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) plan.haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) plan.shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = Number(a.slice(7).trim());
      if (Number.isFinite(n) && n > 0) plan.deepen = n;
    } else if (a === 'thin-pack') plan.thinPack = true;
    // no-progress, ofs-delta, filter, done: accepted, no behaviour needed.
  }
  return plan;
}

function v2FetchResponse(store: Store, repo: Repo, plan: FetchPlan): Buffer {
  const sel = selectFetch(store, repo, plan);
  // v2 section headers are matched by the client with their trailing
  // newline ('acknowledgments\n'); without it the section is rejected.
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  parts.push(pktLine(sel.ack !== null ? `ACK ${sel.ack}\n` : 'NAK\n'));
  if (sel.ack !== null) parts.push(pktLine('ready\n'));
  parts.push(pktDelim());
  if (sel.shallowOut.length > 0 || sel.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of sel.shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  if (sel.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(sel.objects));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(store: Store, repo: Repo, plan: FetchPlan): Buffer {
  const sel = selectFetch(store, repo, plan);
  const parts: Buffer[] = [];
  if (sel.ack !== null) parts.push(pktLine(`ACK ${sel.ack}`));
  else parts.push(pktLine('NAK'));
  for (const s of sel.shallowOut) parts.push(pktLine(`shallow ${s}`));
  for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}`));
  if (sel.objects.length > 0) parts.push(sidebandPack(sel.objects));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function uploadPack(store: Store, owner: string, repoName: string, body: Buffer, isV2: boolean): HandlerResult {
  const repo = store.findRepo(owner, repoName);
  if (!repo) return result(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
  try {
    if (!isV2) {
      // v0: wants section, flush, haves section, flush.
      const { packets } = decodePackets(body);
      const lines = packetLines(packets);
      const plan = parseFetchArgs(lines);
      return result(200, 'application/x-git-upload-pack-result', v0FetchResponse(store, repo, plan));
    }
    const { packets } = decodePackets(body);
    const lines = packetLines(packets);
    const command = lines[0] ?? '';
    const args = lines.slice(1);
    if (command === 'command=ls-refs') {
      return result(200, 'application/x-git-upload-pack-result', handleLsRefs(repo, args));
    }
    if (command === 'command=fetch') {
      const plan = parseFetchArgs(args);
      return result(200, 'application/x-git-upload-pack-result', v2FetchResponse(store, repo, plan));
    }
    return result(400, 'application/json', JSON.stringify({ message: `unknown upload-pack command ${command}` }));
  } catch (err) {
    return result(400, 'application/json', JSON.stringify({ message: `bad upload-pack request: ${(err as Error).message}` }));
  }
}

// ------------------------------------------------------------ receive-pack

export function receivePack(store: Store, owner: string, repoName: string, body: Buffer): HandlerResult {
  const repo = store.findRepo(owner, repoName);
  if (!repo) return result(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
  try {
    const { packets, rest } = decodePackets(body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      const text = p.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const cmd = nul >= 0 ? text.slice(0, nul) : text;
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(cmd.trim());
      if (!m) throw new Error(`invalid receive-pack command ${JSON.stringify(cmd.trim())}`);
      commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]!.trim() });
    }
    const lines: string[] = [];
    if (rest.length > 0) {
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      // readPack returns Map<oid, object>: the oid is the key, not a field
      // of the value (o.oid is undefined) — store by the map key.
      for (const [oid, o] of objects) repo.objects.set(oid, o);
      lines.push('unpack ok');
    } else {
      lines.push('unpack ok');
    }
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
      let ok = false;
      let reason = 'non-fast-forward';
      if (cmd.newOid === ZERO_OID) {
        if (current === cmd.oldOid && current !== ZERO_OID) {
          repo.refs.delete(cmd.ref);
          ok = true;
        }
      } else {
        const newObj = repo.objects.get(cmd.newOid);
        if (newObj) {
          const newCommit = store.peelToCommit(repo, cmd.newOid);
          if (newCommit && current === cmd.oldOid) {
            if (cmd.oldOid === ZERO_OID || store.isAncestor(repo, cmd.oldOid, newCommit)) {
              repo.refs.set(cmd.ref, cmd.newOid);
              ok = true;
            }
          }
        }
      }
      lines.push(ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${reason}`);
    }
    // Report-status lines are newline-terminated on the wire: without the
    // newline the client concatenates "unpack ok" + "ng ..." into one line
    // and reads the unpack as failed.
    const report = Buffer.concat(lines.map((l) => pktLine(`${l}\n`)));
    const bodyOut = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), pktFlush()]);
    return result(200, 'application/x-git-receive-pack-result', bodyOut);
  } catch (err) {
    // Never crash on a bad push body: report the unpack failure and stay up.
    const message = (err as Error).message;
    const report = Buffer.concat([pktLine('unpack ' + message + '\n'), pktLine('ng refs/heads/main unpack-failed\n')]);
    const bodyOut = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), pktFlush()]);
    return result(200, 'application/x-git-receive-pack-result', bodyOut);
  }
}
