import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { REPLY_TOKEN_LIMIT } from '@pixel-twin/shared';
import { safeName } from './safeName';

/** Rough token count: about 3 characters per token. */
export function estimateTokens(json: string): number {
  return Math.ceil(json.length / 3);
}

/**
 * Sends the data inline when it is small. Otherwise saves it to a file and sends the path and a summary.
 * A string is sent (or saved as .txt) as it is; anything else as JSON.
 */
export async function fitReply(
  data: unknown,
  opts: { workDir: string; label: string; summary: string; limitTokens?: number },
): Promise<CallToolResult> {
  const plain = typeof data === 'string';
  const body = plain ? data : JSON.stringify(data);
  const tokens = estimateTokens(body);
  if (tokens <= (opts.limitTokens ?? REPLY_TOKEN_LIMIT)) {
    return { content: [{ type: 'text', text: body }] };
  }
  const dir = path.join(opts.workDir, '.pixel-twin');
  await mkdir(dir, { recursive: true });
  const file = path.resolve(dir, `${safeName(opts.label)}-${Date.now()}.${plain ? 'txt' : 'json'}`);
  await writeFile(file, body);
  return {
    content: [{ type: 'text', text: `Full result saved to ${file} (about ${tokens} tokens). Summary: ${opts.summary}` }],
  };
}
