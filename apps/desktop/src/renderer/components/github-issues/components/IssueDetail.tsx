import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, User, Sparkles, CheckCircle2, Eye } from 'lucide-react';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { ScrollArea } from '../../ui/scroll-area';
import {
  GITHUB_ISSUE_STATE_LABELS,
  GITHUB_COMPLEXITY_COLORS
} from '../../../../shared/constants';
import { MetaLine, SmallCaps } from '../../shared/integration-page';
import { formatDate } from '../utils';
import { AutoFixButton } from './AutoFixButton';
import type { IssueDetailProps } from '../types';

export function IssueDetail({
  issue,
  onInvestigate,
  investigationResult,
  linkedTaskId,
  onViewTask,
  projectId,
  autoFixConfig,
  autoFixQueueItem,
}: IssueDetailProps) {
  const { t, i18n } = useTranslation('common');
  // Determine which task ID to use - either already linked or just created
  const taskId = linkedTaskId || (investigationResult?.success ? investigationResult.taskId : undefined);
  const hasLinkedTask = !!taskId;

  const handleViewTask = () => {
    if (taskId && onViewTask) {
      onViewTask(taskId);
    }
  };

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-4 px-7 py-5">
        {/* Header: title with the link to GitHub, then state and meta */}
        <div>
          <div className="flex items-start gap-3">
            <h2 className="flex-1 text-xl font-semibold leading-snug text-foreground">{issue.title}</h2>
            <Button variant="ghost" size="icon" asChild className="shrink-0 text-muted-foreground">
              <a href={issue.htmlUrl} target="_blank" rel="noopener noreferrer" aria-label={t('accessibility.openOnGitHubAriaLabel')}>
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-3.5">
            <SmallCaps>
              {t(`prReview.state.${issue.state}`, { defaultValue: GITHUB_ISSUE_STATE_LABELS[issue.state] })}
            </SmallCaps>
            <MetaLine
              className="inline"
              parts={[
                `#${issue.number}`,
                issue.author.login,
                formatDate(issue.createdAt, i18n.language, { withYear: true }),
                issue.commentsCount > 0 && t('issues.detail.comments', { count: issue.commentsCount }),
              ]}
            />
          </div>
        </div>

        {/* Labels */}
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {issue.labels.map((label) => (
              <Badge
                key={label.id}
                variant="outline"
                style={{
                  backgroundColor: `#${label.color}20`,
                  borderColor: `#${label.color}50`,
                  color: `#${label.color}`
                }}
              >
                {label.name}
              </Badge>
            ))}
          </div>
        )}

        {/* Actions: one primary action */}
        <div className="flex flex-wrap items-center gap-2">
          {hasLinkedTask ? (
            <Button onClick={handleViewTask} variant="outline">
              <Eye className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('roadmap.viewTask')}
            </Button>
          ) : (
            <>
              <Button onClick={onInvestigate}>
                <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('insights.createTask')}
              </Button>
              {projectId && autoFixConfig?.enabled && (
                <AutoFixButton
                  issue={issue}
                  projectId={projectId}
                  config={autoFixConfig}
                  queueItem={autoFixQueueItem ?? null}
                />
              )}
            </>
          )}
        </div>

        {/* Task Linked Info */}
        {hasLinkedTask && (
          <Card className="bg-success/5 border-success/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-success">
                <CheckCircle2 className="h-4 w-4" />
                {t('issues.detail.taskLinked')}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              {investigationResult?.success ? (
                <>
                  <p className="text-foreground">{investigationResult.analysis.summary}</p>
                  <div className="flex items-center gap-2">
                    <Badge className={GITHUB_COMPLEXITY_COLORS[investigationResult.analysis.estimatedComplexity]}>
                      {t(`issues.complexity.${investigationResult.analysis.estimatedComplexity}`, {
                        defaultValue: investigationResult.analysis.estimatedComplexity
                      })}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {t('issues.detail.taskId', { id: taskId })}
                    </span>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('issues.detail.taskId', { id: taskId })}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Body */}
        <section>
          <SmallCaps as="h3" className="mb-2">{t('prReview.description')}</SmallCaps>
          {issue.body ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.body}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm italic text-muted-foreground">{t('prReview.noDescription')}</p>
          )}
        </section>

        {/* Assignees */}
        {issue.assignees.length > 0 && (
          <section>
            <SmallCaps as="h3" className="mb-2">{t('issues.detail.assignees')}</SmallCaps>
            <div className="flex flex-wrap gap-2">
              {issue.assignees.map((assignee) => (
                <Badge key={assignee.login} variant="outline">
                  <User className="mr-1 h-3 w-3" aria-hidden="true" />
                  {assignee.login}
                </Badge>
              ))}
            </div>
          </section>
        )}

        {/* Milestone */}
        {issue.milestone && (
          <section>
            <SmallCaps as="h3" className="mb-2">{t('issues.detail.milestone')}</SmallCaps>
            <Badge variant="outline">{issue.milestone.title}</Badge>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}
