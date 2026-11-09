/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PreviewNote, PreviewOverlayEvent } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }),
}));

import { NotesPanel } from '../NotesPanel';

const pick = { kind: 'element' as const, rect: { x: 0, y: 0, width: 10, height: 10 }, selector: '#go', text: 'Go', html: '<button>Go</button>', frames: [{ file: 'src/Go.tsx', line: 3 }] };
const saved = (n: number, route = '/login'): PreviewNote => ({ id: `id${n}`, n, route, width: 1280, text: `Note ${n}`, pick, createdAt: '2026-11-09T12:00:00.000Z' });

let emit: (event: PreviewOverlayEvent) => void = () => {};
let api: Record<string, ReturnType<typeof vi.fn>>;

function setup(draft: PreviewNote[] = [], onSend = vi.fn(async () => true)) {
  api = {
    loadNotes: vi.fn(async () => ({ success: true, data: draft })),
    saveNotes: vi.fn(async (_p: string, notes: PreviewNote[]) => ({ success: true, data: notes })),
    setNotesMode: vi.fn(async () => ({ success: true })),
    setPins: vi.fn(async () => ({ success: true })),
    focusPin: vi.fn(async () => ({ success: true })),
    navigate: vi.fn(async () => ({ success: true })),
    onOverlayEvent: vi.fn((callback: (event: PreviewOverlayEvent) => void) => { emit = callback; return () => {}; }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { preview: api };
  const view = render(<NotesPanel projectId="p1" ready onSend={onSend} />);
  return { onSend, ...view };
}

beforeEach(() => {
  emit = () => {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotesPanel', () => {
  it('turns notes mode on while it is open, and off when it closes', async () => {
    const { unmount } = setup();
    await waitFor(() => expect(api.setNotesMode).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole('switch', { name: 'preview.notes.pick' }));
    await waitFor(() => expect(api.setNotesMode).toHaveBeenLastCalledWith(false));
    unmount();
    expect(api.setNotesMode).toHaveBeenLastCalledWith(false);
  });

  it('asks for the text of a pick, and Enter saves it as the next numbered note with its pin', async () => {
    setup([saved(1)]);
    await screen.findByText('Note 1');
    act(() => emit({ type: 'route', route: '/login' }));
    act(() => emit({ type: 'picked', route: '/login', width: 1280, pick, image: 'data:image/png;base64,QQ==' }));
    const box = await screen.findByLabelText('preview.notes.textLabel');
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: 'Smaller button' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Smaller button')).toBeInTheDocument();
    const stored = api.saveNotes.mock.calls.at(-1)![1] as PreviewNote[];
    expect(stored.map((n) => n.n)).toEqual([1, 2]);
    expect(stored[1]).toMatchObject({ route: '/login', text: 'Smaller button', image: 'data:image/png;base64,QQ==' });
    await waitFor(() => expect(api.setPins).toHaveBeenLastCalledWith([{ n: 1, selector: '#go' }, { n: 2, selector: '#go' }]));
  });

  it('Escape drops a pick, and from the page turns picking off', async () => {
    setup();
    act(() => emit({ type: 'picked', route: '/', width: 1280, pick }));
    const box = await screen.findByLabelText('preview.notes.textLabel');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByLabelText('preview.notes.textLabel')).not.toBeInTheDocument();
    act(() => emit({ type: 'escape' }));
    await waitFor(() => expect(api.setNotesMode).toHaveBeenLastCalledWith(false));
  });

  it("marks a note whose element is gone from its page, and takes you to a note's page", async () => {
    setup([saved(1, '/'), saved(2, '/login')]);
    await screen.findByText('Note 2');
    act(() => emit({ type: 'route', route: '/' }));
    act(() => emit({ type: 'detached', ns: [1] }));
    expect(await screen.findByText('preview.notes.detached')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Note 2/ }));
    expect(api.navigate).toHaveBeenCalledWith({ url: '/login' });
    act(() => emit({ type: 'route', route: '/login' }));
    await waitFor(() => expect(api.focusPin).toHaveBeenCalledWith(2));
  });

  it('deletes a note', async () => {
    setup([saved(1)]);
    await screen.findByText('Note 1');
    fireEvent.click(screen.getByRole('button', { name: 'preview.notes.delete' }));
    expect(screen.queryByText('Note 1')).not.toBeInTheDocument();
    expect(api.saveNotes).toHaveBeenLastCalledWith('p1', []);
  });

  it('sends the notes with a title and Quick fix by default, then clears the draft', async () => {
    const { onSend } = setup([saved(1), saved(2)]);
    await screen.findByText('Note 1');
    fireEvent.click(screen.getByRole('button', { name: 'preview.notes.send {"count":2}' }));
    expect(screen.getByLabelText('preview.notes.title')).toHaveValue('Note 1');
    expect(screen.getByRole('radio', { name: /preview.notes.quick/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'preview.notes.sendNow' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith([saved(1), saved(2)], 'Note 1', true));
    await waitFor(() => expect(api.saveNotes).toHaveBeenLastCalledWith('p1', []));
    expect(screen.queryByText('Note 1')).not.toBeInTheDocument();
  });

  it('keeps the notes when sending failed', async () => {
    setup([saved(1)], vi.fn(async () => false));
    await screen.findByText('Note 1');
    fireEvent.click(screen.getByRole('button', { name: 'preview.notes.send {"count":1}' }));
    fireEvent.click(screen.getByRole('radio', { name: /preview.notes.full/ }));
    fireEvent.click(screen.getByRole('button', { name: 'preview.notes.sendNow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('preview.notes.sendFailed');
    expect(screen.getByText('Note 1')).toBeInTheDocument();
  });
});
