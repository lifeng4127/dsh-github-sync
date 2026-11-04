// DSH 目录约定
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
}

export const sessionsRoot = () => join(dshHome(), 'sessions');
export const attachmentsRoot = () => join(dshHome(), 'attachments', 'v1');
export const workspaceJsonPath = () => join(dshHome(), 'storages', 'workspace.json');
export const projcacheRoot = () => join(dshHome(), 'storages', 'session_projcache', 'sessions');
export const spillRoot = () => join(process.env.TEMP ?? process.env.TMP ?? '.', '');
export const pluginDataDir = () => join(dshHome(), 'github-sync');
