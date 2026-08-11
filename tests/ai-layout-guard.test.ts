import { describe, expect, it } from 'vitest';
import {
  findForbiddenColorSyntax,
  findMissingPasswordValues,
  findMissingPreservedTokens,
  findUnbalancedFormattingTags,
} from '../src/shared/ai-layout-guard';

describe('findMissingPreservedTokens', () => {
  it('returns nothing when everything technical is preserved', () => {
    const original = [
      '請參考圖片 ![架構圖](/docs/clients/example-client/architecture.png)',
      '詳見文件連結 [SOP](https://wiki.example.invalid/docs/SOP)',
      '伺服器 IP 為 10.0.0.5，請用帳號 svc-backup 登入。',
      '執行指令 `systemctl restart nginx`',
    ].join('\n');
    const formatted = original; // untouched
    expect(findMissingPreservedTokens(original, formatted)).toEqual([]);
  });

  it('flags a dropped image path', () => {
    const original = '請參考 ![架構圖](/docs/clients/example-client/architecture.png) 內容。';
    const formatted = '請參考架構圖內容。';
    expect(findMissingPreservedTokens(original, formatted)).toContain(
      '/docs/clients/example-client/architecture.png',
    );
  });

  it('flags a dropped IP address', () => {
    const original = '伺服器 IP 為 10.0.0.5。';
    const formatted = '伺服器已設定完成。';
    expect(findMissingPreservedTokens(original, formatted)).toContain('10.0.0.5');
  });

  it('flags a dropped command', () => {
    const original = '執行 `systemctl restart nginx` 重啟服務。';
    const formatted = '重啟服務。';
    expect(findMissingPreservedTokens(original, formatted)).toContain('`systemctl restart nginx`');
  });

  it('flags a dropped hyperlink', () => {
    const original = '詳見 [SOP 文件](https://wiki.example.invalid/docs/SOP)。';
    const formatted = '詳見 SOP 文件。';
    expect(findMissingPreservedTokens(original, formatted)).toContain(
      'https://wiki.example.invalid/docs/SOP',
    );
  });

  it('caps the number of reported tokens at 20', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `IP: 10.0.0.${i}`);
    const original = lines.join('\n');
    const formatted = '全部整理完畢。';
    expect(findMissingPreservedTokens(original, formatted).length).toBe(20);
  });

  it('is not tripped by colour tags wrapped around preserved content', () => {
    const original = '伺服器 IP 為 10.0.0.5，執行 `systemctl restart nginx`。';
    const formatted = '伺服器 IP 為 <font color="blue">10.0.0.5</font>，執行 `systemctl restart nginx`。';
    expect(findMissingPreservedTokens(original, formatted)).toEqual([]);
  });
});

describe('findMissingPasswordValues', () => {
  it('accepts a password kept verbatim even when Markdown emphasis surrounds it', () => {
    const source = '本機帳號 **admin**，密碼 **local-pass_123**。';
    expect(findMissingPasswordValues(source, source)).toEqual([]);
  });

  it('flags a password replaced with a masking label without returning it to the UI', () => {
    const source = 'Password: `local-pass_123`';
    const formatted = 'Password: `[已遮蔽]`';
    expect(findMissingPasswordValues(source, formatted)).toEqual(['local-pass_123']);
  });
});

describe('findUnbalancedFormattingTags', () => {
  it('returns nothing for balanced colour, highlight and underline markup', () => {
    const text = '> **<font color="red">警告：</font>** <mark>會中斷網路</mark>，請<u>先通知客戶</u>。';
    expect(findUnbalancedFormattingTags(text)).toEqual([]);
  });

  it('flags an unclosed font tag', () => {
    const issues = findUnbalancedFormattingTags('<font color="red">警告：停機');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('<font>');
    expect(issues[0]).toContain('1 個');
  });

  it('flags a stray closing tag', () => {
    expect(findUnbalancedFormattingTags('警告：停機</mark>')[0]).toContain('<mark>');
  });

  it('flags each tag type independently', () => {
    const issues = findUnbalancedFormattingTags('<font color="red">a<mark>b');
    expect(issues).toHaveLength(2);
  });

  it('ignores tags inside fenced code blocks and inline code', () => {
    const text = ['說明如下：', '```html', '<font color="red">範例', '```', '行內：`<mark>範例`'].join('\n');
    expect(findUnbalancedFormattingTags(text)).toEqual([]);
  });

  it('does not confuse <ul>/<u> when counting underline tags', () => {
    expect(findUnbalancedFormattingTags('<ul><li>項目</li></ul>')).toEqual([]);
  });
});

describe('findForbiddenColorSyntax', () => {
  it('counts span-color the model newly introduced', () => {
    expect(findForbiddenColorSyntax('警告：停機', '<span style="color:red">警告</span>：停機')).toBe(1);
  });

  it('ignores span-color that the original page already had', () => {
    const original = '<span style="color:red">警告</span>：停機';
    expect(findForbiddenColorSyntax(original, original)).toBe(0);
  });

  it('reports only the newly added ones', () => {
    const original = '<span style="color:red">A</span>';
    const formatted = '<span style="color:red">A</span><span style="color: blue">B</span>';
    expect(findForbiddenColorSyntax(original, formatted)).toBe(1);
  });

  it('does not flag the allowed font-colour or font-size span syntax', () => {
    const formatted = '<font color="red">A</font><span style="font-size:18px">B</span>';
    expect(findForbiddenColorSyntax('AB', formatted)).toBe(0);
  });
});
