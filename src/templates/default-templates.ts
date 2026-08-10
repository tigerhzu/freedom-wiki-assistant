import type { Template } from '../shared/types';

/** Seeded on first run (see template-service.ts). */
export const DEFAULT_TEMPLATES: Template[] = [
  {
    id: 'builtin-eng-morning-meeting',
    name: '工程部晨會會議紀錄',
    category: '會議',
    description: '每日晨會固定格式，插入時自動帶入當天日期。',
    content: [
      '# {{date_slash}} 工程部晨會會議紀錄',
      '',
      '開會開始時間：{{date_slash}} 09:30',
      '開會結束時間：{{date_slash}} 09:45',
      '',
      '會議參與人員：',
      '',
      '公出人員：',
      '請假人員：',
      '',
      '會議主持人：',
      '會議記錄：',
      '',
      '## HALO 案件檢視',
      '',
      '## 其他事項',
      '',
    ].join('\n'),
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  },
];
