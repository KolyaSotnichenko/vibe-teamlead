/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AppShell } from '../AppShell';

afterEach(cleanup);

describe('AppShell', () => {
  it('never lets the window scroll: the frame is exactly the window height and clips', () => {
    render(
      <AppShell sidebar={<aside>sidebar</aside>} header={<div>tabs</div>} content={<div>page</div>}>
        <div>dialogs</div>
      </AppShell>
    );
    const frame = screen.getByTestId('app-shell');
    expect(frame).toHaveClass('h-screen', 'overflow-hidden');
    expect(frame).toContainElement(screen.getByText('sidebar'));
  });

  it('gives the content area the remaining height and lets it scroll itself', () => {
    render(
      <AppShell sidebar={<aside>sidebar</aside>} header={<div>tabs</div>} content={<div>page</div>}>
        <div>dialogs</div>
      </AppShell>
    );
    const content = screen.getByRole('main');
    expect(content).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(content).toContainElement(screen.getByText('page'));
    expect(content).not.toContainElement(screen.getByText('sidebar'));
    expect(content).not.toContainElement(screen.getByText('tabs'));
    expect(content).not.toContainElement(screen.getByText('dialogs'));
    // The column holding tabs + content may shrink below its content (min-h-0) and never scrolls itself
    expect(content.parentElement).toHaveClass('min-h-0', 'flex-col', 'overflow-hidden');
  });

  it('puts the status bar under both the sidebar and the page, outside the content area', () => {
    render(
      <AppShell sidebar={<aside>sidebar</aside>} content={<div>page</div>} statusBar={<footer>status</footer>} />
    );
    const frame = screen.getByTestId('app-shell');
    const status = screen.getByText('status');
    // The frame stacks a row (sidebar + page) over the bar; the bar is the last child of the frame
    expect(frame).toHaveClass('flex-col');
    expect(frame.lastElementChild).toBe(status);
    const row = frame.firstElementChild as HTMLElement;
    expect(row).toHaveClass('min-h-0', 'flex-1');
    expect(row).toContainElement(screen.getByText('sidebar'));
    expect(row).toContainElement(screen.getByRole('main'));
    expect(row).not.toContainElement(status);
  });
});
