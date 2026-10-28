import { PluginError, PluginTimeoutError } from '../src/errors';
import { exportPicture } from '../src/design/exportPicture';

const params = { nodeId: '1:2', format: 'PNG' as const, scale: 2 };
const LOST = 'Unable to establish connection to Figma';

/** A bridge whose answers come from `replies` in turn: an Error is thrown, anything else returned. */
function bridgeOf(...replies: unknown[]) {
  let calls = 0;
  return {
    calls: () => calls,
    call: async () => {
      const reply = replies[calls++];
      if (reply instanceof Error) throw reply;
      return reply as { base64: string };
    },
  };
}

test('a failed export is tried once more', async () => {
  const bridge = bridgeOf(new PluginError(LOST), { base64: 'AAAA' });
  expect(await exportPicture(bridge as never, 'c', params, 0)).toEqual({ base64: 'AAAA' });
  expect(bridge.calls()).toBe(2);
});

test('two failures give a plain explanation with Figma\'s own words', async () => {
  const bridge = bridgeOf(new PluginError(LOST), new PluginError(LOST));
  const err = await exportPicture(bridge as never, 'c', params, 0).then(() => new Error('no error'), (e: Error) => e);
  expect(err.message).toContain('lost its connection to Figma\'s servers');
  expect(err.message).toContain('failed twice');
  expect(err.message).toContain(LOST);
  expect(bridge.calls()).toBe(2);
});

test('a timeout is not tried again', async () => {
  const bridge = bridgeOf(new PluginTimeoutError('exportNode', 120_000), { base64: 'AAAA' });
  await expect(exportPicture(bridge as never, 'c', params, 0)).rejects.toBeInstanceOf(PluginTimeoutError);
  expect(bridge.calls()).toBe(1);
});
