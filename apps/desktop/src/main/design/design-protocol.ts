/**
 * vt-design:// — a task's design frames for the Design tab, from its spec folder:
 *
 *   vt-design://task/<taskId>/<file under design/>    the frames (HTML), their shots (PNG)
 *   vt-design://task/<taskId>/spec/<image>             QA's screenshots of the built pages
 *   vt-design://project/<projectId>/<file>             the project's design library (design-library.ts)
 *
 * The HTML is written by the designer agent: it is served with a strict CSP (no network except
 * Google Fonts and the pinned GSAP, no fetches, no forms) into sandboxed iframes, and a small
 * script is added so a click on an element can become a comment.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { libraryDir } from '../ai/design/design-library';

export const DESIGN_SCHEME = 'vt-design';

export const DESIGN_CSP = [
  "default-src 'none'",
  "img-src vt-design: data: blob:",
  "style-src 'unsafe-inline' vt-design: https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/gsap@3.13.0/",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const SPEC_IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export interface DesignUrl {
  taskId: string;
  file: string;
  /** design: under <spec>/design/; spec: an image anywhere in the spec folder (QA's screenshots) */
  area: 'design' | 'spec';
}

export function parseDesignUrl(raw: string): DesignUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DESIGN_SCHEME}:` || url.hostname !== 'task') return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts.length < 2) return null;
  const [taskId, ...rest] = parts;
  if (rest[0] === 'spec') return rest.length > 1 ? { taskId, file: rest.slice(1).join('/'), area: 'spec' } : null;
  return { taskId, file: rest.join('/'), area: 'design' };
}

/**
 * The script added to every frame. Comment mode: a click is not followed; its element (a CSS path)
 * and point go to the Design tab. Always: where the links to other screens are (for the flow
 * arrows on the canvas, and which page the prototype is on), and a click beside any link flashes
 * the clickable spots, as in Figma's prototype. Posts only to its parent.
 */
const PICK_SCRIPT = `<script>(()=>{let on=false;
const screenLink=(h)=>/\\.html([?#]|$)/.test(h||'')&&!/^[a-z][a-z0-9+.-]*:|^\\/\\//i.test(h||'');
const sel=(el)=>{const p=[];while(el&&el.nodeType===1&&el!==document.body&&p.length<8){let s=el.tagName.toLowerCase();if(el.id){p.unshift(s+'#'+CSS.escape(el.id));break;}const sib=el.parentElement?[...el.parentElement.children].filter((c)=>c.tagName===el.tagName):[];if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(el)+1)+')';p.unshift(s);el=el.parentElement;}return p.join(' > ');};
const links=()=>[...document.querySelectorAll('a[href]')].filter((a)=>screenLink(a.getAttribute('href'))).map((a)=>{const r=a.getBoundingClientRect();return{href:a.getAttribute('href'),x:Math.round(r.left+scrollX),y:Math.round(r.top+scrollY),w:Math.round(r.width),h:Math.round(r.height)};}).filter((l)=>l.w>0&&l.h>0).slice(0,200);
const report=()=>parent.postMessage({type:'vt-design:links',page:location.pathname,links:links()},'*');
addEventListener('load',()=>{report();setTimeout(report,600);});addEventListener('resize',report);
const flash=()=>{for(const l of links()){const d=document.createElement('div');d.style.cssText='position:absolute;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #2f6feb;background:rgba(47,111,235,.18);transition:opacity .35s;left:'+l.x+'px;top:'+l.y+'px;width:'+l.w+'px;height:'+l.h+'px';document.body.appendChild(d);setTimeout(()=>{d.style.opacity='0';setTimeout(()=>d.remove(),400);},500);}};
addEventListener('message',(e)=>{if(e.source!==parent)return;const d=e.data||{};if(d.type==='vt-design:mode'){on=!!d.on;document.documentElement.style.cursor=on?'crosshair':'';}});
addEventListener('click',(e)=>{const t=e.target instanceof Element?e.target:null;if(on){e.preventDefault();e.stopPropagation();parent.postMessage({type:'vt-design:pick',selector:t?sel(t):'',x:Math.round(e.pageX),y:Math.round(e.pageY),text:t?(t.textContent||'').trim().slice(0,120):''},'*');return;}if(t&&t.closest('a[href],button,input,select,textarea,label,summary,[role=button],[onclick]'))return;flash();},true);
})();</script>`;

function withPickScript(html: string): string {
  const at = html.search(/<\/body>/i);
  return at === -1 ? `${html}${PICK_SCRIPT}` : `${html.slice(0, at)}${PICK_SCRIPT}${html.slice(at)}`;
}

function insideSpec(specDir: string, relative: string): string | null {
  if (!relative || relative.includes('\0')) return null;
  const root = path.resolve(specDir);
  const full = path.resolve(root, relative);
  return full.startsWith(root + path.sep) ? full : null;
}

type Asset = { mime: string; body: Buffer | string; headers: Record<string, string> };

/** The response for one URL, or null (not found / not allowed). Never throws. */
export function designAsset(specDir: string, target: DesignUrl): Asset | null {
  const rootDir = target.area === 'design' ? path.join(specDir, 'design') : specDir;
  return serve(rootDir, target.file, target.area === 'spec' ? SPEC_IMAGES : null);
}

/** A file of the project's design library (vt-design://project/<projectId>/<file>). Never throws. */
export function libraryAsset(projectRoot: string, file: string): Asset | null {
  return serve(libraryDir(projectRoot), file, null);
}

export function parseLibraryUrl(raw: string): { projectId: string; file: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DESIGN_SCHEME}:` || url.hostname !== 'project') return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  return parts.length >= 2 ? { projectId: parts[0], file: parts.slice(1).join('/') } : null;
}

function serve(rootDir: string, file: string, only: Set<string> | null): Asset | null {
  try {
    const full = insideSpec(rootDir, file);
    if (!full) return null;
    const ext = path.extname(full).toLowerCase();
    const mime = MIME[ext];
    if (!mime || (only && !only.has(ext))) return null;
    if (!existsSync(full)) return null;
    // No links: a symlink in the folder must not reach a file outside it
    if (!lstatSync(full).isFile()) return null;
    const real = realpathSync(full);
    const root = realpathSync(rootDir);
    if (!real.startsWith(root + path.sep)) return null;
    const headers = { 'Content-Security-Policy': DESIGN_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (ext === '.html') return { mime, body: withPickScript(readFileSync(full, 'utf-8')), headers };
    return { mime, body: readFileSync(full), headers };
  } catch {
    return null;
  }
}
