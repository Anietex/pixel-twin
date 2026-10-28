import { figmaLink, parseFigmaLink, toPluginNodeId } from '../src/link';

test('design link with node id', () => {
  expect(parseFigmaLink('https://www.figma.com/design/AbC123/Landing-Page?node-id=1-2&t=x'))
    .toEqual({ fileKey: 'AbC123', fileSlug: 'Landing-Page', nodeId: '1:2' });
});
test('old /file/ link without node id', () => {
  expect(parseFigmaLink('https://figma.com/file/AbC123/Landing'))
    .toEqual({ fileKey: 'AbC123', fileSlug: 'Landing', nodeId: null });
});
test('branch link uses the branch key', () => {
  expect(parseFigmaLink('https://www.figma.com/design/AbC123/branch/BrX9/Landing?node-id=4-5').fileKey).toBe('BrX9');
});
test('url-encoded node id', () => {
  expect(parseFigmaLink('https://www.figma.com/design/K/N?node-id=1%3A2').nodeId).toBe('1:2');
});
test('node id inside an instance', () => {
  expect(toPluginNodeId('I12-3;4-5')).toBe('I12:3;4:5');
  expect(toPluginNodeId('1:2')).toBe('1:2');
});
test('rejects links that are not Figma design files', () => {
  expect(() => parseFigmaLink('https://example.com/x')).toThrow('Not a Figma design link');
  expect(() => parseFigmaLink('https://www.figma.com/board/K/N')).toThrow('Not a Figma design link');
});
test('figmaLink builds a design link that parses back to the same file and layer', () => {
  expect(figmaLink('AbC123', 'Landing Page', '1:3')).toBe('https://www.figma.com/design/AbC123/Landing-Page?node-id=1-3');
  for (const nodeId of ['1:3', 'I5:1;7:2']) {
    expect(parseFigmaLink(figmaLink('AbC123', ' Café / Home ', nodeId))).toEqual(
      { fileKey: 'AbC123', fileSlug: 'Café-/-Home', nodeId });
  }
  expect(parseFigmaLink(figmaLink('K', '   ', '1:2')).fileSlug).toBe('file');
});
