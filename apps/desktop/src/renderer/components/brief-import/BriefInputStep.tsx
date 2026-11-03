/**
 * Step 1: a brief file (drop or choose) or a free-form description.
 * A chosen file wins over the text; the textarea is disabled while a file is set.
 */

import { useId, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Upload, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { BRIEF_FILE_EXTENSIONS, fileNameOf, formatFileSize, isSupportedBriefFile } from './brief-review-model';
import { fieldClass, ghostButton, InlineError, secondaryButton } from './brief-ui';

export interface BriefFile {
  path: string;
  name: string;
  size?: number;
}

export function BriefInputStep({
  file,
  text,
  onFileChange,
  onTextChange,
  error,
  onRetry,
}: {
  file: BriefFile | null;
  text: string;
  onFileChange: (file: BriefFile | null) => void;
  onTextChange: (text: string) => void;
  /** Analysis failed (shown with Retry) */
  error?: string | null;
  onRetry?: () => void;
}) {
  const { t } = useTranslation(['tasks']);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const depth = useRef(0);
  const textId = useId();
  const hintId = useId();
  const fileErrorId = useId();

  const pick = async () => {
    setFileError(null);
    setPicking(true);
    try {
      const result = await window.electronAPI.brief.pickFile();
      if (result.success && result.data) {
        const path = result.data;
        if (!isSupportedBriefFile(path)) {
          setFileError(t('tasks:briefImport.input.unsupported', { types: BRIEF_FILE_EXTENSIONS.join(' ') }));
          return;
        }
        onFileChange({ path, name: fileNameOf(path) });
      } else if (!result.success) {
        setFileError(result.error ?? t('tasks:briefImport.input.pickFailed'));
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : t('tasks:briefImport.input.pickFailed'));
    } finally {
      setPicking(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    depth.current = 0;
    setDragging(false);
    setFileError(null);
    const dropped = e.dataTransfer.files?.[0];
    if (!dropped) return;
    if (!isSupportedBriefFile(dropped.name)) {
      setFileError(t('tasks:briefImport.input.unsupported', { types: BRIEF_FILE_EXTENSIONS.join(' ') }));
      return;
    }
    const path = window.electronAPI.brief.pathForFile(dropped);
    if (!path) {
      setFileError(t('tasks:briefImport.input.noPath'));
      return;
    }
    onFileChange({ path, name: dropped.name, size: dropped.size });
  };

  const dragHandlers = {
    onDragEnter: (e: DragEvent) => {
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      e.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop,
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <p id={hintId} className="max-w-prose text-[15px] leading-relaxed text-muted-foreground">
        {t('tasks:briefImport.input.explain')}
      </p>

      {error && (
        <InlineError
          title={t('tasks:briefImport.errors.analyseTitle')}
          message={error}
          onRetry={onRetry}
          retryLabel={t('tasks:briefImport.errors.retry')}
        />
      )}

      {/* File */}
      <section aria-labelledby={`${hintId}-file`}>
        <h3 id={`${hintId}-file`} className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">
          {t('tasks:briefImport.input.fileHeading')}
        </h3>
        {file ? (
          <div className="flex items-center gap-3 border border-foreground py-1 pr-1 pl-4">
            <FileText aria-hidden className="h-5 w-5 shrink-0 text-foreground" strokeWidth={1.5} />
            <div className="min-w-0 flex-1 py-2">
              <p className="truncate text-sm font-semibold text-foreground">{file.name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {file.size !== undefined && <span className="mr-3">{formatFileSize(file.size)}</span>}
                <span>{file.path}</span>
              </p>
            </div>
            <button type="button" onClick={() => void pick()} disabled={picking} className={ghostButton}>
              {t('tasks:briefImport.input.replace')}
            </button>
            <button
              type="button"
              onClick={() => onFileChange(null)}
              aria-label={t('tasks:briefImport.input.removeFile', { name: file.name })}
              className={cn(ghostButton, 'w-11 px-0')}
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div
            {...dragHandlers}
            data-dragging={dragging || undefined}
            aria-describedby={fileError ? fileErrorId : undefined}
            className={cn(
              'flex flex-col items-center justify-center gap-3 border border-dashed px-6 py-8 text-center transition-colors motion-reduce:transition-none',
              dragging ? 'border-foreground bg-accent' : fileError ? 'border-destructive' : 'border-foreground/50'
            )}
          >
            <Upload aria-hidden className="h-5 w-5 text-foreground" strokeWidth={1.5} />
            <p className="text-sm font-semibold text-foreground">
              {dragging ? t('tasks:briefImport.input.dropNow') : t('tasks:briefImport.input.dropHere')}
            </p>
            <p className="font-mono text-xs text-muted-foreground">{BRIEF_FILE_EXTENSIONS.filter((x) => x !== '.markdown').join('  ')}</p>
            <button type="button" onClick={() => void pick()} disabled={picking} className={secondaryButton}>
              {t('tasks:briefImport.input.chooseFile')}
            </button>
          </div>
        )}
        {fileError && (
          <p id={fileErrorId} className="mt-2 text-sm text-destructive">
            {fileError}
          </p>
        )}
      </section>

      <div className="flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-border" />
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{t('tasks:briefImport.input.or')}</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* Text */}
      <section>
        <label htmlFor={textId} className="mb-2 block text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">
          {t('tasks:briefImport.input.textHeading')}
        </label>
        <textarea
          id={textId}
          rows={9}
          value={text}
          disabled={!!file}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t('tasks:briefImport.input.textPlaceholder')}
          className={cn(fieldClass, 'min-h-[180px] resize-y text-[15px] leading-relaxed')}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {file ? t('tasks:briefImport.input.fileWins') : t('tasks:briefImport.input.textHint')}
        </p>
      </section>
    </div>
  );
}
