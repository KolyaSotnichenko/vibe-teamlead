/**
 * The Knowledge pages: they live in the status bar (not the sidebar). The sidebar's keyboard
 * handler still takes their shortcuts, so C, L, M and H open them as before.
 */
import { BookMarked, BookOpen, FileText, Wrench } from 'lucide-react';
import type { ElementType } from 'react';
import type { SidebarView } from '../Sidebar';

export interface KnowledgeItem {
  id: SidebarView;
  labelKey: string;
  icon: ElementType;
  shortcut: string;
}

export const KNOWLEDGE_ITEMS: KnowledgeItem[] = [
  { id: 'context', labelKey: 'navigation:items.context', icon: BookOpen, shortcut: 'C' },
  { id: 'changelog', labelKey: 'navigation:items.changelog', icon: FileText, shortcut: 'L' },
  { id: 'agent-tools', labelKey: 'navigation:items.agentTools', icon: Wrench, shortcut: 'M' },
  { id: 'docs', labelKey: 'navigation:items.docs', icon: BookMarked, shortcut: 'H' },
];
