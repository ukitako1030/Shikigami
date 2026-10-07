import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function codexConfigPath() {
  return path.resolve(process.env.SHIKIGAMI_CODEX_CONFIG || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'));
}

const readConfig = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headingName = value => value.replace(/["'\s]/g, '');

// Replaces only [mcp_servers.<server>] and its sub-tables. TOML is not fully parsed, so any other way of
// defining the same server is reported instead of being rewritten into a file Codex can no longer load.
export function replaceServerSection(original, server, section) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const own = `mcp_servers.${server}`;
  const key = `["']?${escapeRegExp(server)}["']?\\s*[.=]`;
  const conflicts = [new RegExp(`^\\s*mcp_servers\\s*=`), new RegExp(`^\\s*["']?mcp_servers["']?\\s*\\.\\s*${key}`)];
  const conflictsInServersTable = new RegExp(`^\\s*${key}`);
  const preserved = [];
  let table = '', inOwn = false, multiline = null;
  for (const line of original.split(/\r?\n/)) {
    if (multiline) {
      if (line.includes(multiline)) multiline = null;
      if (!inOwn) preserved.push(line);
      continue;
    }
    const heading = /^\s*(\[\[?)\s*([^\[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (heading) {
      table = headingName(heading[2]);
      inOwn = heading[1] === '[' && (table === own || table.startsWith(`${own}.`));
    } else if (!inOwn && (conflicts.some(pattern => table === '' && pattern.test(line)) || (table === 'mcp_servers' && conflictsInServersTable.test(line)))) {
      throw Object.assign(new Error(`Codexの設定に「${server}」が別の書き方で登録されています。設定ファイルを確認してください: `), {status:409, conflict:true});
    }
    for (const quote of ['"""', "'''"]) if ((line.split(quote).length - 1) % 2 === 1) { multiline = quote; break; }
    if (!inOwn) preserved.push(line);
  }
  const kept = preserved.join(eol).trimEnd();
  const body = section.replace(/\r?\n/g, eol);
  return kept ? `${kept}${eol}${eol}${body}` : body;
}

// Writes atomically after a backup and refuses to overwrite a file another process changed meanwhile.
export async function upsertCodexServer({server, section, backupTag}) {
  const config = codexConfigPath();
  await fs.mkdir(path.dirname(config), {recursive:true});
  for (let attempt = 0; attempt < 3; attempt++) {
    const original = await readConfig(config);
    let updated;
    try { updated = replaceServerSection(original, server, section); }
    catch (error) { if (error.conflict) error.message += config; throw error; }
    if (updated === original) return {ok:true, updated:false, config, requiresReload:true};
    const backup = original ? `${config}.${backupTag}-backup-${Date.now()}` : null;
    const temporary = `${config}.${backupTag}-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, updated, {flag:'wx'});
      if (await readConfig(config) !== original) continue;
      if (backup) await fs.writeFile(backup, original, {flag:'wx'});
      await fs.rename(temporary, config);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return {ok:true, updated:true, config, backup, requiresReload:true};
  }
  throw Object.assign(new Error('設定ファイルが同時に更新されています。再試行してください'), {status:409});
}
