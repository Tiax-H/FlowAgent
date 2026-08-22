/**
 * report demo MCP Server 的确定性报告生成实现（纯函数，无副作用）。
 */

export interface ReportSection {
  heading: string;
  body: string;
}

export interface ReportInput {
  title: string;
  sections: ReportSection[];
  metadata?: Record<string, string>;
}

export function validateReportInput(input: ReportInput): string | null {
  if (input.title.trim().length === 0) return 'title 不能为空';
  if (input.sections.length === 0) return 'sections 不能为空';
  for (const section of input.sections) {
    if (section.heading.trim().length === 0) return 'section.heading 不能为空';
  }
  return null;
}

export function generateMarkdownReport(input: ReportInput): string {
  const lines: string[] = [`# ${input.title}`, ''];
  const entries = Object.entries(input.metadata ?? {});
  if (entries.length > 0) {
    lines.push('| 键 | 值 |', '| --- | --- |');
    for (const [key, value] of entries) lines.push(`| ${key} | ${value} |`);
    lines.push('');
  }
  for (const section of input.sections) {
    lines.push(`## ${section.heading}`, '', section.body, '');
  }
  return `${lines.join('\n').trim()}\n`;
}

export interface CitationSource {
  title: string;
  url: string;
}

export function validateCitations(sources: CitationSource[]): string | null {
  for (const source of sources) {
    if (source.title.trim().length === 0) return 'source.title 不能为空';
    try {
      const parsed = new URL(source.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `source.url 只支持 http/https: ${source.url}`;
      }
    } catch {
      return `source.url 格式非法: ${source.url}`;
    }
  }
  return null;
}

export function formatCitations(sources: CitationSource[]): string {
  return sources
    .map((source, index) => `- [${index + 1}] ${source.title} — ${source.url}`)
    .join('\n');
}
