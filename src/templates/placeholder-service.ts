/**
 * Template placeholder resolution. Pure — all environment values are passed
 * in through PlaceholderContext, so this is fully unit testable.
 */

export interface PlaceholderContext {
  now: Date;
  pageTitle: string;
  /**
   * Current login user name. Only filled when the site exposes it safely
   * (wikiConfig.user.resolveCurrentUser); otherwise empty — never guessed.
   */
  currentUser: string;
}

const WEEKDAYS_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const pad = (n: number) => String(n).padStart(2, '0');

export function resolvePlaceholders(content: string, ctx: PlaceholderContext): string {
  const d = ctx.now;
  const year = String(d.getFullYear());
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());

  const values: Record<string, string> = {
    date: `${year}-${month}-${day}`,
    date_slash: `${year}/${month}/${day}`,
    date_compact: `${year}${month}${day}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    year,
    month,
    day,
    weekday_zh: WEEKDAYS_ZH[d.getDay()],
    page_title: ctx.pageTitle,
    current_user: ctx.currentUser,
  };

  return content.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in values ? values[key] : whole,
  );
}

/** List of supported placeholders, for UI hints. */
export const SUPPORTED_PLACEHOLDERS = [
  '{{date}}',
  '{{date_slash}}',
  '{{date_compact}}',
  '{{time}}',
  '{{year}}',
  '{{month}}',
  '{{day}}',
  '{{weekday_zh}}',
  '{{page_title}}',
  '{{current_user}}',
] as const;
