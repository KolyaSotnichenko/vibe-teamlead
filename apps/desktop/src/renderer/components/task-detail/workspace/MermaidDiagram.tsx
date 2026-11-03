/**
 * Mermaid diagram, rendered with the design-system tokens.
 * Lazy: this module (and the mermaid package, loaded with a dynamic import on
 * first render) is only fetched when a diagram is actually on screen.
 */

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MermaidConfig } from 'mermaid';
import { cleanMermaidSource, mermaidErrorText } from '../../../../shared/utils/mermaid-source';

type MermaidModule = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidModule> | null = null;
function loadMermaid(): Promise<MermaidModule> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

/** mermaid.render is not re-entrant: run renders one at a time. */
let renderQueue: Promise<unknown> = Promise.resolve();

function token(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

/** Theme from the live CSS variables, so light/dark follow the app. */
export function buildMermaidConfig(): MermaidConfig {
  const styles = getComputedStyle(document.documentElement);
  const dark = document.documentElement.classList.contains('dark');
  const ink = token(styles, '--vt-ink', '#1C1D19');
  const paper = token(styles, '--vt-paper', '#EFF0EA');
  const ground = token(styles, '--vt-ground', '#E8EAE3');
  const groundAlt = token(styles, '--vt-ground-alt', '#DFE1D9');
  const hairline = token(styles, '--vt-hairline', '#C6C8BE');
  const inkLine = token(styles, '--vt-ink-line', '#33352E');
  const inkSoft = token(styles, '--vt-ink-line-soft', '#26271F');
  const inkHover = token(styles, '--vt-ink-hover', '#2A2C25');
  const muted = token(styles, dark ? '--vt-text-muted-dark-soft' : '--vt-text-secondary', '#4C4F46');
  const signal = token(styles, dark ? '--vt-signal-on-dark' : '--vt-signal-text', '#B5340F');

  const surface = dark ? inkSoft : paper;
  const text = dark ? paper : ink;
  const line = dark ? token(styles, '--vt-text-muted-dark', '#8C8E83') : ink;
  const border = dark ? token(styles, '--vt-text-muted-dark', '#8C8E83') : ink;

  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: "'Archivo', 'Inter Tight', system-ui, sans-serif",
    // Root fontSize overrides the per-diagram sizes (actorFontSize etc.), so set it here
    fontSize: 13,
    themeVariables: {
      darkMode: dark,
      background: dark ? ink : ground,
      fontFamily: "'Archivo', 'Inter Tight', system-ui, sans-serif",
      fontSize: '13px',
      primaryColor: surface,
      primaryTextColor: text,
      primaryBorderColor: border,
      secondaryColor: dark ? inkHover : groundAlt,
      secondaryTextColor: text,
      secondaryBorderColor: border,
      tertiaryColor: dark ? ink : ground,
      tertiaryTextColor: text,
      tertiaryBorderColor: dark ? inkLine : hairline,
      lineColor: line,
      textColor: text,
      mainBkg: surface,
      nodeBorder: border,
      clusterBkg: dark ? ink : ground,
      clusterBorder: dark ? inkLine : hairline,
      titleColor: text,
      edgeLabelBackground: dark ? ink : ground,
      noteBkgColor: dark ? inkHover : groundAlt,
      noteTextColor: text,
      noteBorderColor: dark ? inkLine : hairline,
      actorBkg: surface,
      actorBorder: border,
      actorTextColor: text,
      actorLineColor: dark ? inkLine : hairline,
      signalColor: line,
      signalTextColor: text,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: muted,
      activationBkgColor: dark ? inkHover : groundAlt,
      activationBorderColor: border,
      sequenceNumberColor: surface,
      errorBkgColor: surface,
      errorTextColor: signal,
    },
    // Radius 0, no shadows — the design system is square
    themeCSS: 'rect, .basic.label-container, .node rect, .cluster rect { rx: 0 !important; ry: 0 !important; } * { filter: none !important; }',
    // Natural size (13px text) instead of stretching to the container; wide diagrams scroll
    flowchart: { curve: 'linear', htmlLabels: false, useMaxWidth: false },
    sequence: {
      mirrorActors: false,
      showSequenceNumbers: false,
      useMaxWidth: false,
      actorFontSize: 13,
      messageFontSize: 13,
      noteFontSize: 12,
      actorFontFamily: "'Archivo', 'Inter Tight', system-ui, sans-serif",
      messageFontFamily: "'Archivo', 'Inter Tight', system-ui, sans-serif",
      noteFontFamily: "'Archivo', 'Inter Tight', system-ui, sans-serif",
      boxMargin: 8,
      height: 44,
    },
    er: { useMaxWidth: false, fontSize: 13 },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
  };
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export default function MermaidDiagram({ source, label }: { source: string; label?: string }) {
  const { t } = useTranslation(['tasks']);
  const reactId = useId();
  const dark = useIsDark();
  const [state, setState] = useState<{ svg?: string; error?: string }>({});
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = `mmd-${reactId.replace(/[^a-zA-Z0-9]/g, '')}-${dark ? 'd' : 'l'}`;
    const job = renderQueue.then(async () => {
      const mermaid = await loadMermaid();
      mermaid.initialize(buildMermaidConfig());
      try {
        const { svg } = await mermaid.render(id, cleanMermaidSource(source));
        if (!cancelled) setState({ svg });
      } catch (error) {
        // mermaid leaves an error node behind on failure
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setState({ error: mermaidErrorText(error) });
      }
    });
    renderQueue = job.catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [source, dark, reactId]);

  return (
    <figure className="not-prose mx-0 mb-0 border border-border bg-background">
      {state.error ? (
        <div className="px-4 py-3 text-sm">
          <p className="text-destructive">{t('tasks:workspace.architecture.mermaidError')}</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre font-mono text-xs text-muted-foreground">{state.error}</pre>
        </div>
      ) : state.svg ? (
        <div
          role="img"
          aria-label={label}
          className="flex overflow-x-auto p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:shrink-0"
          // Output of mermaid.render with securityLevel 'strict' (DOMPurify-sanitized, no scripts or click handlers)
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by mermaid (securityLevel strict)
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : (
        <div role="status" aria-busy="true" className="px-4 py-6 text-sm text-muted-foreground">
          {t('tasks:workspace.architecture.mermaidLoading')}
        </div>
      )}
      <div className="flex justify-end border-t border-border">
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          aria-expanded={showSource}
          className="min-h-11 px-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {showSource ? t('tasks:workspace.architecture.hideSource') : t('tasks:workspace.architecture.showSource')}
        </button>
      </div>
      {showSource && (
        <pre className="m-0 max-h-72 overflow-auto border-t border-border bg-muted p-3 font-mono text-[12px] leading-relaxed text-foreground">
          {source}
        </pre>
      )}
    </figure>
  );
}
