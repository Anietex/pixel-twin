import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { isOpaquePng, openEncoder, type ImageType } from '../browser/encodeImage';
import type { ServerDeps } from '../createServer';
import { imageInfo, type ImageInfo, planAssets, slug, type AssetPlan } from '../design/assets';
import { exportPicture } from '../design/exportPicture';
import { loadSection } from '../design/loadSection';
import type { Layer } from '../design/types';
import { insideProject } from '../paths';
import { fitReply } from '../reply';
import { safeName } from '../safeName';
import { loadSettings } from '../settings';
import { resolveTarget, toolError } from './common';

/**
 * One saved file.
 * - convertedFrom: an opaque PNG or a JPG photo was saved as WebP (or JPG) instead.
 * - cappedFrom: the original picture's size, when it was shrunk to twice the size it is shown at.
 * - srcset: the sizes of a picture, smallest first, each with its width in px, for an img srcset.
 * - sameAs: the layer whose file has the same content; no new file was written.
 */
interface Exported {
  layerId: string; layerName: string; kind: AssetPlan['kind']; path: string; width: number; height: number; kb: number;
  convertedFrom?: 'png' | 'jpg';
  cappedFrom?: { width: number; height: number };
  srcset?: { path: string; width: number }[];
  sameAs?: string;
}

/** The list of exported files that export_assets keeps in assetsDir, by layer id. Paths are relative to assetsDir. */
export const ASSET_LIST_FILE = 'pixel-twin-assets.json';
interface ListEntry {
  layerName: string; kind: AssetPlan['kind']; file: string; width: number; height: number;
  shown: { width: number; height: number }; srcset?: { file: string; width: number }[]; sameAs?: string;
}

/** Figma names SVG parts with the layer id, such as clip0_12_345. Two icons that differ only there are the same. */
const sameSvgText = (svg: string) => svg.replace(/\b(clip|paint|filter|mask|pattern|image)(\d+)(_[a-z]+)?_\d+_\d+\b/g, '$1$2$3');

/** How much to shrink an original picture so it is CAP_SCALE times the size it is shown at (1 or more: leave it). */
function capFactor(info: { width: number; height: number }, shown: { width: number; height: number }, scaleMode: string | undefined): number {
  if (info.width <= 0 || info.height <= 0 || shown.width <= 0 || shown.height <= 0) return 1;
  const across = shown.width / info.width;
  const down = shown.height / info.height;
  // FILL covers the layer (the bigger scale); FIT shows the whole picture inside it (the smaller one).
  if (scaleMode === 'FILL') return CAP_SCALE * Math.max(across, down);
  if (scaleMode === 'FIT') return CAP_SCALE * Math.min(across, down);
  return 1;
}

/** Reads an image's type and size. Any failure counts as 'unusable'. */
function safeInfo(bytes: Buffer): ImageInfo | null {
  try { return imageInfo(bytes); } catch { return null; }
}

const findLayer = (layer: Layer, id: string): Layer | undefined =>
  layer.id === id ? layer : layer.children.map((c) => findLayer(c, id)).find((l) => l !== undefined);

/** Original pictures are shrunk to this many times the size they are shown at (2x for sharp screens). */
const CAP_SCALE = 2;
/** A PNG or JPG smaller than this keeps its format (KB): icons and small pictures gain nothing. */
const CONVERT_ABOVE_KB = 50;
const PHOTO_TYPE = { webp: { mime: 'image/webp', ext: 'webp' }, jpg: { mime: 'image/jpeg', ext: 'jpg' } } as const;
const MIME_OF: Record<string, ImageType> = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' };
/** A smaller size is made only when the file is wider than this many times the size wanted. */
const SIZE_SLACK = 1.1;

/**
 * Adds the exported files to ASSET_LIST_FILE in `dir`, by layer id, keeping entries of other sections.
 * A list that can't be read is started again.
 */
async function writeAssetList(dir: string, files: Exported[], shownOf: Map<string, { width: number; height: number }>): Promise<void> {
  const listFile = path.join(dir, ASSET_LIST_FILE);
  let list: Record<string, ListEntry> = {};
  try {
    const old = JSON.parse(await readFile(listFile, 'utf8'));
    if (old && typeof old === 'object' && !Array.isArray(old)) list = old;
  } catch {
    list = {};
  }
  const rel = (file: string) => path.relative(dir, file).split(path.sep).join('/');
  for (const f of files) {
    list[f.layerId] = {
      layerName: f.layerName, kind: f.kind, file: rel(f.path), width: f.width, height: f.height,
      shown: shownOf.get(f.layerId) ?? { width: 0, height: 0 },
      ...(f.srcset ? { srcset: f.srcset.map((s) => ({ file: rel(s.path), width: s.width })) } : {}),
      ...(f.sameAs ? { sameAs: f.sameAs } : {}),
    };
  }
  await writeFile(listFile, `${JSON.stringify(list, null, 2)}\n`);
}

export function registerAssets(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'export_assets',
    {
      description:
        'Saves the images and SVG icons of a Figma section as files in assetsDir (a folder inside the project), one icon per file. Returns the file path, kind, size and KB of each. '
        + 'Original pictures more than twice the size they are shown at are shrunk to twice that size. Opaque PNG and JPG photos over 50 KB are saved as WebP (or JPG) when smaller; PNG stays for transparency. '
        + 'Each picture bigger than it is shown also gets smaller copies at its shown width and twice that, listed in srcset for an img srcset. '
        + `A file with the same content as an earlier one is not saved again: its entry has sameAs and the earlier path. Also keeps ${ASSET_LIST_FILE} in assetsDir: `
        + 'each layer id with its file, size, shown size and srcset. Needs a node id in the link or in nodeId.',
      inputSchema: z.object({
        link: z.string().describe('A Figma link to a file or node'),
        nodeId: z.string().optional().describe('Node id such as 1-2 or 1:2. Overrides the node in the link.'),
        shrinkImages: z.boolean().optional().describe('Shrink original pictures that are more than twice the size they are shown at to twice that size (default true)'),
        photoFormat: z.enum(['webp', 'jpg', 'png']).optional()
          .describe('Format for opaque PNG and JPG pictures over 50 KB (default webp; jpg leaves JPGs as they are). Pictures with transparency always stay PNG.'),
        srcset: z.boolean().optional()
          .describe('Also save each picture at its shown width (1x) and twice that (2x), when the file is bigger, for an img srcset (default true)'),
        assetsDir: z.string().optional().describe('Folder for the files. A relative path starts at the project folder. Default: assetsDir in pixel-twin.json.'),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ link, nodeId, assetsDir, shrinkImages = true, photoFormat = 'webp', srcset = true }) => {
      const browserPage: { encoder?: Awaited<ReturnType<typeof openEncoder>> } = {};   // opened on first use
      try {
        const folder = assetsDir ?? (await loadSettings(deps.workDir)).assetsDir;
        if (!folder) return toolError('Give assetsDir, or set assetsDir in pixel-twin.json.');
        const dir = insideProject(deps.workDir, folder);
        if (!dir) return toolError('assetsDir must be inside the project folder');
        const target = await resolveTarget(deps, link, nodeId);
        if (!target.nodeId) return toolError('The link has no node-id. Use get_outline to pick a section first.');
        const { section } = await loadSection(deps.bridge, target.file, target.nodeId);
        const id = target.file.connectionId;
        await mkdir(dir, { recursive: true });

        const out: Exported[] = [];
        const shownOf = new Map<string, { width: number; height: number }>();
        const firstWith = new Map<string, Exported>();   // content hash → the first entry with that content
        // An opaque PNG photo, or a JPG photo when WebP is asked for, is saved as WebP (or JPG) when that is smaller. PNG stays for transparency.
        const smaller = async (ext: string, data: Buffer | string): Promise<{ ext: string; data: Buffer | string; converted: boolean }> => {
          const unchanged = { ext, data, converted: false };
          if (photoFormat === 'png' || typeof data === 'string' || data.length <= CONVERT_ABOVE_KB * 1024) return unchanged;
          if (!(ext === 'jpg' && photoFormat === 'webp') && !(ext === 'png' && isOpaquePng(data))) return unchanged;
          browserPage.encoder ??= await openEncoder(deps.browser);
          const type = PHOTO_TYPE[photoFormat];
          const encoded = await browserPage.encoder.encode(data, type.mime);
          return encoded.length < data.length ? { ext: type.ext, data: encoded, converted: true } : unchanged;
        };
        // The sizes for an img srcset: the shown width (1x) and twice it (2x), made only from a bigger file.
        const sizesOf = async (file: string, ext: string, data: Buffer | string, size: { width: number; height: number },
          shown: { width: number; height: number }): Promise<Exported['srcset']> => {
          if (!srcset || typeof data === 'string' || !MIME_OF[ext] || shown.width <= 0 || size.width <= 0) return undefined;
          const widths = [Math.round(shown.width), Math.round(shown.width * 2)].filter((w) => size.width > w * SIZE_SLACK);
          if (widths.length === 0) return undefined;
          browserPage.encoder ??= await openEncoder(deps.browser);
          const list: NonNullable<Exported['srcset']> = [];
          for (const w of widths) {
            const h = Math.max(1, Math.round((size.height * w) / size.width));
            const variant = file.replace(/\.(\w+)$/, `-${w}w.$1`);
            await writeFile(variant, await browserPage.encoder.resize(data, w, h, MIME_OF[ext]));
            list.push({ path: variant, width: w });
          }
          return [...list, { path: file, width: size.width }];
        };
        const save = async (plan: AssetPlan, rawExt: string, raw: Buffer | string, size: { width: number; height: number },
          kind: AssetPlan['kind'], shown: { width: number; height: number }, cappedFrom?: { width: number; height: number }) => {
          shownOf.set(plan.layerId, shown);
          // The same content as an earlier file: point to that file instead of saving it again.
          const hash = createHash('sha256').update(typeof raw === 'string' ? sameSvgText(raw) : raw).digest('hex');
          const first = firstWith.get(hash);
          if (first) {
            out.push({ ...first, layerId: plan.layerId, layerName: plan.layerName, sameAs: first.layerId });
            return;
          }
          const { ext, data, converted } = await smaller(rawExt, raw);
          const file = path.join(dir, `${slug(plan.layerName)}-${safeName(plan.layerId)}.${ext}`);
          await writeFile(file, data);
          const sizes = kind === 'svg' ? undefined : await sizesOf(file, ext, data, size, shown);
          const entry: Exported = { layerId: plan.layerId, layerName: plan.layerName, kind, path: file, ...size,
            kb: Math.round(Buffer.byteLength(data) / 1024), ...(converted ? { convertedFrom: rawExt as 'png' | 'jpg' } : {}),
            ...(cappedFrom ? { cappedFrom } : {}), ...(sizes ? { srcset: sizes } : {}) };
          firstWith.set(hash, entry);
          out.push(entry);
        };
        const render = async (plan: AssetPlan, layer: Layer | undefined, format: 'PNG' | 'JPG' = 'PNG') => {
          const r = await exportPicture(deps.bridge, id, { nodeId: plan.layerId, format, scale: 2 });
          if (!r.base64) throw new Error(`Figma did not return a picture for ${plan.layerName} (${plan.layerId}).`);
          const bytes = Buffer.from(r.base64, 'base64');
          const info = safeInfo(bytes);
          await save(plan, format === 'JPG' ? 'jpg' : 'png', bytes,
            { width: info?.width ?? layer?.width ?? 0, height: info?.height ?? layer?.height ?? 0 }, 'image-render',
            { width: layer?.width ?? 0, height: layer?.height ?? 0 });
        };

        for (const plan of planAssets(section.root)) {
          const layer = findLayer(section.root, plan.layerId);
          const box = { width: layer?.width ?? 0, height: layer?.height ?? 0 };
          if (plan.kind === 'svg') {
            const r = await exportPicture(deps.bridge, id, { nodeId: plan.layerId, format: 'SVG', scale: 1 });
            if (!r.svg) throw new Error(`Figma did not return an SVG for ${plan.layerName} (${plan.layerId}).`);
            await save(plan, 'svg', r.svg, box, 'svg', box);
          } else if (plan.kind === 'image-original') {
            let bytes: Buffer | null = null;
            try {
              bytes = Buffer.from((await deps.bridge.call(id, 'getImageBytes', { imageHash: plan.imageRef })).base64, 'base64');
            } catch {
              bytes = null; // the plugin cannot find the image: use a render instead
            }
            let info = bytes && safeInfo(bytes);
            if (!bytes || !info) {
              await render(plan, layer, info?.ext === 'jpg' ? 'JPG' : 'PNG');
              continue;
            }
            // A picture more than twice the size it is shown at is shrunk to twice that size, which is
            // enough for sharp screens. A moved or cropped picture and an animated GIF keep their size.
            const scaleMode = layer?.fills.find((f) => f.type === 'image')?.scaleMode;
            const factor = shrinkImages && !plan.adjusted && info.ext !== 'gif' ? capFactor(info, box, scaleMode) : 1;
            let cappedFrom: { width: number; height: number } | undefined;
            if (factor < 1 / SIZE_SLACK) {
              const width = Math.max(1, Math.round(info.width * factor));
              const height = Math.max(1, Math.round(info.height * factor));
              try {
                browserPage.encoder ??= await openEncoder(deps.browser);
                bytes = await browserPage.encoder.resize(bytes, width, height, MIME_OF[info.ext]);
                cappedFrom = { width: info.width, height: info.height };
                info = { ...info, width, height };
              } catch {
                // No browser to shrink it: Figma's 2x picture of a layer with no children is the next best.
                if ((layer?.children.length ?? 0) === 0) {
                  await render(plan, layer, info.ext === 'jpg' ? 'JPG' : 'PNG');
                  continue;
                }
              }
            }
            await save(plan, info.ext, bytes, { width: info.width || box.width, height: info.height || box.height }, 'image-original', box, cappedFrom);
          } else {
            await render(plan, layer);
          }
        }
        out.sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path)) || a.layerId.localeCompare(b.layerId));
        await writeAssetList(dir, out, shownOf);
        return await fitReply(out, {
          workDir: deps.workDir,
          label: 'assets',
          summary: `${out.length} files saved in ${dir}`,
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      } finally {
        await browserPage.encoder?.close().catch(() => undefined);
      }
    },
  );
}
