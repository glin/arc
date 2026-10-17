import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as path from 'path';
import { formatSessionLink, parseSessionLink } from './domain/session-link';
import { citationScanner, nativeCitationPath } from './domain/file-citation';
import { marked } from 'marked';

const reportedSources =
  'Sources: :codex-file-citation{path="C:/Users/example/Downloads/claude_api_cost_2026_09_11_to_2026_10_10.csv" purpose="source"} and :codex-file-citation{path="C:/Users/example/Downloads/claude_api_tokens_2026_09_11_to_2026_10_10.csv" purpose="source"}';

test('reported Codex Sources response exposes both literal file destinations', () => {
  if (process.platform !== 'win32') return;
  const html = renderRichMarkdown(reportedSources);
  for (const subject of ['cost', 'tokens']) {
    const filename = `claude_api_${subject}_2026_09_11_to_2026_10_10.csv`;
    assert.ok(html.includes(`data-link="C:/Users/example/Downloads/${filename}"`), html);
    assert.ok(html.includes(`>Source: ${filename}</a>`), html);
  }
  assert.equal((html.match(/data-link-kind="file-citation"/g) || []).length, 2);
  assert.doesNotMatch(html, /codex-file-citation\{/);
});

test('exported Codex Sources response identifies both full paths without local actions', () => {
  if (process.platform !== 'win32') return;
  const html = renderRichMarkdown(reportedSources, undefined, true);
  for (const subject of ['cost', 'tokens'])
    assert.ok(
      html.includes(`Source: C:/Users/example/Downloads/claude_api_${subject}_2026_09_11_to_2026_10_10.csv`),
      html,
    );
  assert.doesNotMatch(html, /<a|data-link|data-image|<button|codex-file-citation\{/);
});

const citationPath = (name: string) => (process.platform === 'win32' ? `C:/outside/${name}` : `/outside/${name}`);
const citation = (file = citationPath('file.csv'), attributes = '') =>
  `:codex-file-citation{path='${file}' ${attributes}}`;

test('ordinary prose keeps HTTP autolinks beside citation candidates', () => {
  for (const source of ['See https://example.com', 'Read http://example.com/a.', '*See https://example.com*']) {
    assert.match(renderRichMarkdown(source), /data-link="https?:\/\/example.com/);
    assert.match(renderRichMarkdown(`${source} ${citation()}`), /data-link="https?:\/\/example.com/);
  }
});

test('renderer candidate discovery stays bounded across ordinary Markdown tokens', () => {
  const original = String.prototype.indexOf;
  for (const count of [100, 1000, 4000]) {
    for (const suffix of ['', citation()]) {
      const source = '*a* '.repeat(count) + suffix;
      let searched = 0;
      const discovery = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
        this: string,
        needle: string,
        position?: number,
      ) {
        const found = original.call(this, needle, position);
        if (needle === ':' || needle === '\uE000') searched += found < 0 ? this.length : found + 1;
        return found;
      });
      try {
        const html = renderRichMarkdown(source);
        if (suffix) assert.match(html, /data-link-kind/);
        else assert.doesNotMatch(html, /data-link-kind/);
      } finally {
        discovery.mockRestore();
      }
      assert.ok(searched <= source.length * 8, `${source.length} code units requested ${searched} search code units`);
    }
  }
});

test('tables and surrounding emphasis retain literal citation interiors', () => {
  const actual = process.platform;
  try {
    for (const platform of ['win32', 'linux', 'darwin']) {
      Object.defineProperty(process, 'platform', { value: platform });
      for (const filename of ['a|b.csv', 'a\\|b.csv']) {
        const file = citationPath(filename);
        const source = `| File |\n| --- |\n| ${citation(file, 'purpose=source')} |`;
        assert.ok(renderRichMarkdown(source).includes(`data-link="${escapeHtml(file)}"`));
        assert.ok(renderRichMarkdown(source, undefined, true).includes(`Source: ${escapeHtml(file)}`));
      }
      const file = citationPath('one.csv');
      const source = `*See ${citation(file, 'label="*" purpose=output')}*`;
      assert.ok(renderRichMarkdown(source).includes(`data-link="${file}"`));
      assert.match(renderRichMarkdown(source), /<em>See <a/);
      assert.ok(renderRichMarkdown(source, undefined, true).includes(`Output: ${file}`));
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: actual });
  }
});

test('written private-use text remains literal beside masked citation candidates', () => {
  for (const prefix of ['\uE000', '\uE00000000000\uE001', '\uE00000000001\uE001']) {
    const html = renderRichMarkdown(`${prefix} ${citation()}`);
    assert.ok(html.includes(prefix));
    assert.match(html, /data-link-kind/);
  }
});

test('ignored metadata leaves adjacent citation destinations eligible', () => {
  const actual = process.platform;
  try {
    for (const platform of ['win32', 'linux', 'darwin']) {
      Object.defineProperty(process, 'platform', { value: platform });
      const one = citationPath('one%20#L10.csv');
      const two = citationPath('two:10.csv');
      for (const [metadata, tail] of [
        ['<code>', ''],
        ['<a href="x">', ''],
        ['<!--', ''],
        ['<script>', ''],
        ['`', '`'],
        ['[', '](x)'],
        ['![', '](x)'],
        ['[', '][ref]\n\n[ref]: x'],
      ]) {
        const source = `${citation(one, `label='${metadata}' purpose=source`)} ${citation(two, 'purpose=output')} ${tail}`;
        for (const inert of [false, true]) {
          const html = renderRichMarkdown(source, undefined, inert);
          if (inert) {
            assert.ok(html.includes(`Source: ${one}`), `${platform}: ${source}: ${html}`);
            assert.ok(html.includes(`Output: ${two}`), `${platform}: ${source}: ${html}`);
            assert.doesNotMatch(html, /<a|data-link-kind/);
          } else {
            for (const file of [one, two])
              assert.ok(html.includes(`data-link="${file}"`), `${platform}: ${source}: ${html}`);
            assert.equal((html.match(/data-link-kind="file-citation"/g) || []).length, 2, html);
          }
          assert.doesNotMatch(html, /codex-file-citation\{/);
        }
      }
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: actual });
  }
});

test('existing Markdown protection preserves closing syntax inside citation-shaped text', () => {
  const actual = process.platform;
  try {
    for (const platform of ['win32', 'linux', 'darwin']) {
      Object.defineProperty(process, 'platform', { value: platform });
      const one = citationPath('one.csv');
      const two = citationPath('two.csv');
      for (const [prefix, closing, expected] of [
        ['`', '`', /<code>:codex-file-citation/],
        ['[prefix ', '](x)', /data-link="x"/],
        ['![prefix ', '](x)', /prefix :codex-file-citation/],
        ['before <code>', '</code>', /&lt;\/code&gt;/],
        ['before <a href="x">', '</a>', /&lt;\/a&gt;/],
        ['before <!--', '-->', /--&gt;/],
        ['before <script>', '</script>', /&lt;\/script&gt;/],
      ] as const) {
        for (const gap of prefix.includes('<') ? ['', '\n\n'] : ['']) {
          const protectedText = `${prefix}${gap}${citation(one, `label='${closing}'`)}`;
          const source = `${protectedText} ${citation(two)}`;
          for (const inert of [false, true]) {
            const html = renderRichMarkdown(source, undefined, inert);
            assert.ok(visibleTextOf(html).includes(one), `${platform}: ${source}: ${html}`);
            assert.ok(html.includes('codex-file-citation'), html);
            if (inert) {
              assert.doesNotMatch(html, /<a|data-link/);
              assert.ok(html.includes(two), html);
            } else {
              assert.doesNotMatch(html, new RegExp(`data-link="${one}"`));
              assert.ok(html.includes(`data-link="${two}"`), `${platform}: ${source}: ${html}`);
              assert.equal((html.match(/data-link-kind="file-citation"/g) || []).length, 1, html);
              assert.match(html, expected);
            }
          }
        }
      }
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: actual });
  }
});

test('citation arbitration consumes token-rich source without repeated inline lexing', () => {
  for (const count of [100, 1000, 4000]) {
    const source = Array.from({ length: count }, () => `*a* ${citation()} \`literal\` `).join('');
    let calls = 0;
    let inlineLength = 0;
    const spies = (['escape', 'tag', 'link', 'reflink', 'codespan', 'autolink'] as const).map((name) => {
      const original = marked.Tokenizer.prototype[name];
      return vi.spyOn(marked.Tokenizer.prototype, name).mockImplementation(function (
        this: marked.Tokenizer,
        ...args: unknown[]
      ) {
        calls += 1;
        return Reflect.apply(original, this, args);
      });
    });
    const inline = marked.Lexer.prototype.inlineTokens;
    spies.push(
      vi.spyOn(marked.Lexer.prototype, 'inlineTokens').mockImplementation(function (this: marked.Lexer, text, tokens) {
        inlineLength += text.length;
        return inline.call(this, text, tokens);
      }) as (typeof spies)[number],
    );
    try {
      assert.equal((renderRichMarkdown(source).match(/data-link-kind/g) || []).length, count);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    assert.ok(calls <= count * 100, `${count} citations requested ${calls} tokenizer calls`);
    assert.ok(
      inlineLength <= source.length * 4,
      `${source.length} source units requested ${inlineLength} inline units`,
    );
  }
});

test('nested citations stay literal inside unknown malformed and streamed directives', () => {
  const inner = citation(citationPath('one.csv'), 'purpose=source');
  for (const source of [
    `:artifact{body="${inner}"}`,
    `:artifact{bad.key="${inner}"}`,
    `:artifact{body=${inner}}`,
    `:artifact {body="${inner}"}`,
    `:artifact{label='<code>' body="${inner}"}`,
    `:artifact{bad.key='<!--' body="${inner}"}`,
    `:artifact{body='[ ${inner} ](x)'`,
  ]) {
    for (let end = 0; end <= source.length; end += 1) {
      assert.doesNotMatch(renderRichMarkdown(source.slice(0, end)), /data-link-kind/, `${source}: ${end}`);
      assert.doesNotMatch(renderRichMarkdown(source.slice(0, end), undefined, true), /<a|data-link/, `${end}`);
    }
  }
});

test('file citations preserve punctuation and announce full literal paths', () => {
  for (const filename of [
    'file%20name.csv',
    'file name.csv',
    'case#L10',
    'case:10',
    'a&copy;[x](y){z}?.csv',
    '雪.csv',
    'a"b.csv',
  ]) {
    const file = citationPath(filename);
    const html = renderRichMarkdown(citation(file, 'purpose=output label=ignored sheet=Dashboard range=A1:D8'));
    assert.ok(html.includes(`data-link="${escapeHtml(file)}"`), html);
    assert.ok(html.includes(`title="${escapeHtml(file)}"`), html);
    assert.ok(html.includes(`aria-label="Output: ${escapeHtml(file)}"`), html);
    assert.ok(html.includes(`>Output: ${escapeHtml(filename)}</a>`), html);
    assert.doesNotMatch(html, /ignored|Dashboard|A1:D8/);
  }
  const html = renderRichMarkdown(citation(citationPath('file.csv'), 'purpose=unknown'));
  assert.match(html, />file.csv<\/a>/);
  const apostrophe = citationPath("team's.csv");
  assert.ok(
    renderRichMarkdown(`:codex-file-citation{path="${apostrophe}"}`).includes(`data-link="${escapeHtml(apostrophe)}"`),
  );
  const root = process.platform === 'win32' ? 'C:/' : '/';
  assert.ok(renderRichMarkdown(citation(root)).includes(`>${root}</a>`));
});

test('colliding citation basenames display distinct written paths across Markdown blocks', () => {
  const one = citationPath('a/same.csv');
  const two = citationPath('b/same.csv');
  const html = renderRichMarkdown(`${citation(one)}\n\n${citation(two)}\n\n${citation(one)}`);
  for (const file of [one, two]) assert.ok(html.includes(`>${file}</a>`), html);
  assert.ok(renderRichMarkdown(`${citation(one)} and ${citation(one)}`).includes('>same.csv</a>'));
});

test('citation path admission has independent native platform expectations', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const windows = platform === 'win32';
    for (const file of ['C:/Downloads/one.csv', 'c:\\Downloads\\one.csv', 'C:\\Downloads\\'])
      assert.equal(nativeCitationPath(file, platform), windows ? file : null, `${platform}: ${file}`);
    for (const file of ['/Downloads/One.csv', '/Downloads/one.csv', '/雪 file.csv', '/Downloads/a:10'])
      assert.equal(nativeCitationPath(file, platform), windows ? null : file, `${platform}: ${file}`);
    for (const file of [
      '',
      'relative.csv',
      '~/file.csv',
      'C:relative.csv',
      '\\\\server\\file.csv',
      '//server/file.csv',
      'file:///tmp/a',
      'https://example.com/a',
      'sandbox:/file',
      '/tmp/a\n.csv',
      '/tmp/a\u0000',
    ])
      assert.equal(nativeCitationPath(file, platform), null, `${platform}: ${file}`);
  }
});

test('citation grammar accepts colon counts and quotation modes without decoding filenames', () => {
  const file = citationPath('one.csv');
  for (const count of [1, 2, 3])
    for (const quote of ['', '"', "'"]) {
      const source = `${':'.repeat(count)}codex-file-citation{path = ${quote}${file}${quote}\tpurpose = source}`;
      assert.ok(renderRichMarkdown(source).includes(`data-link="${file}"`), source);
    }
  const source = `:codex-file-citation{path="${citationPath('a')}\\"b.csv"}`;
  assert.equal(citationScanner(source.length).scan(source)?.attributes.get('path'), citationPath('a"b.csv'));
  const trailing = ':codex-file-citation{path="C:\\Downloads\\"}';
  assert.equal(citationScanner(trailing.length).scan(trailing)?.attributes.get('path'), 'C:\\Downloads\\');
});

test('malformed and unsupported citations retain original text without file actions', () => {
  const file = citationPath('one.csv');
  for (const source of [
    `::::codex-file-citation{path='${file}'}`,
    `:Codex-file-citation{path='${file}'}`,
    `:codex-file-citation {path='${file}'}`,
    `:codex-file-citation{path='${file}' path='${file}'}`,
    ':codex-file-citation{path=""}',
    ':codex-file-citation{path=}',
    `:codex-file-citation{bad.key=one path='${file}'}`,
    `:codex-file-citation{path='${file}\n'}`,
    `:codex-file-citation{path='${file}'`,
    citation('relative.csv'),
    citation('file:///tmp/file.csv'),
    citation(process.platform === 'win32' ? '/tmp/file.csv' : 'C:/Downloads/file.csv'),
    `:artifact{path='${file}'}`,
    `:artifact{body="${citation(file)}"}`,
  ]) {
    const html = renderRichMarkdown(source);
    assert.doesNotMatch(html, /data-link-kind/, source);
    assert.ok(visibleTextOf(html.replace(/<br>/g, '\n')).includes(source), `${source}: ${html}`);
  }
});

test('Markdown literal contexts never create citation actions', () => {
  const marker = citation();
  for (const source of [
    `\`${marker}\``,
    `\`\`\`text\n${marker}\n\`\`\``,
    `~~~\n${marker}\n~~~`,
    `    ${marker}`,
    `>     ${marker}`,
    `- item\n\n      ${marker}`,
    `[${marker}](file.csv)`,
    `![${marker}](file.csv)`,
    `[label](<${marker}>)`,
    `[ref]: <${marker}>\n\n[Read][ref]`,
    `<div title="${marker}">text</div>`,
    `<!-- ${marker} -->`,
    `before <!-- ${marker} --> after`,
    `before <code>${marker}</code> after`,
    `\\${marker}`,
    marker.replace(':', '&#58;'),
    `\\:${marker}`,
    `\\::${marker}`,
    marker.replace('codex', '&#99;odex'),
    `<details><summary>${marker}</summary>\nBody\n</details>`,
  ])
    assert.doesNotMatch(renderRichMarkdown(source), /data-link-kind/, source);
  assert.match(renderRichMarkdown(`\\\\${marker}`), /data-link-kind/);
  assert.match(renderRichMarkdown(`<details><summary>Files</summary>\n${marker}\n</details>`), /data-link-kind/);
  assert.doesNotMatch(renderInlineMarkdown(marker), /<a|data-link/);
});

test('malformed directives in protected Markdown leave later citations eligible', () => {
  for (const protectedText of [
    '` :artifact{body= `',
    '```\n:artifact{body=\n```',
    '[ :artifact{body= ](file.csv)',
    '[ :artifact{body= ][ref]\n\n[ref]: file.csv',
    'before <code>:artifact{body=</code>',
    '<!-- :artifact{body= -->',
  ]) {
    const html = renderRichMarkdown(`${protectedText}\n\n${citation()}`);
    assert.equal((html.match(/data-link-kind/g) || []).length, 1, html);
  }
});

test('every streamed citation prefix stays nonactionable until its closing brace arrives', () => {
  const source = citation(citationPath('file%20name.csv'), 'purpose=source');
  for (let end = 0; end < source.length; end += 1)
    assert.doesNotMatch(renderRichMarkdown(source.slice(0, end)), /data-link-kind/, `${end}`);
  assert.match(renderRichMarkdown(source), /data-link-kind/);
});

test('malformed citation scanning shares a four-code-unit allowance across retries', () => {
  const source = ':codex-file-citation{path='.repeat(1000) + 'tail';
  const scanner = citationScanner(source.length);
  for (let offset = 0; offset < source.length; offset += 1)
    if (source[offset] === ':') scanner.scan(source.slice(offset));
  assert.equal(scanner.inspected, source.length * 4);
  assert.equal(scanner.exhausted, true);
  assert.equal(scanner.scan(citation()), null);
  assert.doesNotMatch(renderRichMarkdown(source), /data-link-kind/);
  const many = Array.from({ length: 300 }, (_, index) => citation(citationPath(`${index}.csv`))).join(' ');
  assert.equal((renderRichMarkdown(many).match(/data-link-kind/g) || []).length, 300);
});

test('named session links decode once, reject malformed destinations, and keep exports inert', () => {
  for (const session of ['7390194c-8fea-4b6d-80be-e7e8c7684426', 'transcript-id', 'literal%2f', 'a:b', 'é']) {
    const href = formatSessionLink(session)!;
    assert.deepEqual(parseSessionLink(href), { kind: 'session', session });
    assert.deepEqual(parseSessionLink('  ' + href.toUpperCase().slice(0, 12) + href.slice(12)), {
      kind: 'session',
      session,
    });
  }
  for (const target of [
    '',
    '%',
    '%zz',
    '%2f',
    '%5c',
    '%00',
    '%7f',
    '%C2%80',
    'id?x',
    'id#x',
    'id/path',
    'id\\path',
    ' id',
    'id ',
  ]) {
    assert.deepEqual(parseSessionLink('arc-session:' + target), { kind: 'invalid' });
    if (!target.includes(' '))
      assert.doesNotMatch(renderRichMarkdown(`[Name](arc-session:${target})`), /data-link="arc-session:/);
  }
  assert.deepEqual(parseSessionLink('https://example.com'), { kind: 'other' });
  assert.equal(formatSessionLink('bad/id'), null);
  const text = '[**Cache & controls**](arc-session:saved-id)';
  const html = renderRichMarkdown(text);
  assert.match(html, /aria-label="Open session: Cache &amp; controls"/);
  assert.match(html, /<strong>Cache &amp; controls<\/strong>/);
  assert.doesNotMatch(renderRichMarkdown(text, undefined, true), /<a|arc-session:|data-link/);
  assert.match(renderRichMarkdown('`arc-session:saved-id`'), /<code>arc-session:saved-id<\/code>/);
});
import {
  escapeHtml,
  visibleTextOf,
  hasImageReference,
  imageFileFor,
  imagePathFor,
  linkTargetIsImage,
  renderInlineMarkdown,
  renderRichMarkdown,
  richMarkdown,
  VISUALIZATION_SCHEME,
  visualizationPath,
  withoutRichContent,
} from './richtext.ts';

const file = path.resolve('fixtures', 'new-session-mockups.html');
const reference = (over: Record<string, unknown> = {}) =>
  `\uE200visualize\uE202${JSON.stringify({ path: file, ...over })}\uE201`;

test('a visualization reference becomes a readable local action', () => {
  const drawn = richMarkdown(`Before.\n\n${reference()}\n\nAfter.`);
  assert.match(drawn, /Open interactive visualization: New session mockups/);
  const href = new RegExp(`\\(${VISUALIZATION_SCHEME.replace(':', '\\:')}([^)]*)\\)`).exec(drawn);
  assert.ok(href, 'the readable action has no visualization target');
  assert.equal(visualizationPath(VISUALIZATION_SCHEME + href[1]), path.normalize(file));
  assert.doesNotMatch(drawn, /[\uE200-\uE202]/, 'the host control characters still reach the card');
});

test('the response renderer turns the reference into a native button', () => {
  const html = renderRichMarkdown(reference());
  assert.match(html, /<button type="button" class="editor-link visualization-link"/);
  assert.ok(html.includes(`data-visualization="${file}"`), 'the button carries a different local path');
  assert.match(html, />Open interactive visualization: New session mockups<\/button>/);
  assert.doesNotMatch(html, /[\uE200-\uE202]/, 'the host control characters still reach the rendered response');
});

test('ordinary Markdown stays formatted and raw HTML stays inert', () => {
  const html = renderRichMarkdown('**Done.**\n\n[Read](https://example.com)\n\n<script>alert(1)</script>');
  assert.match(html, /<strong>Done\.<\/strong>/);
  assert.match(html, /data-link="https:\/\/example\.com"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('balanced disclosures render tight and spaced Markdown bodies through safe native tags', () => {
  for (const gap of ['\n', '\n\n']) {
    const html = renderRichMarkdown(
      `<DETAILS > <SUMMARY >Agent **measurements** [reference](x.md)</SUMMARY>${gap}| Agent | Result |\n| --- | --- |\n| Sol | Passed |\n\n- [Read](src/store.ts)\n\n\`\`\`text\nexact code\n\`\`\`\n\n<details>\n<summary>Nested</summary>\n**Body**\n</details>\n</DETAILS>`,
    );
    assert.equal((html.match(/<details>/g) ?? []).length, 2);
    assert.match(html, /<summary[^>]*>Agent <strong>measurements<\/strong> reference<\/summary>/);
    assert.match(html, /<table>/);
    assert.match(html, /<ul>/);
    assert.match(html, /data-link="src\/store.ts"/);
    assert.match(html, /<pre><code class="language-text">exact code/);
    assert.match(html, /<strong>Body<\/strong>/);
  }
});

test('reference definitions resolve across outside, disclosure, and nested bodies', () => {
  const html = renderRichMarkdown(
    '[Outside][inner]\n\n<details><summary>[Info][outer]</summary>\n\n[Read][outer]\n\n[inner]: src/inner.ts\n\n<details><summary>Nested</summary>\n\n[Deep][inner]\n\n[nested]: src/nested.ts\n\n</details>\n</details>\n\n[After][nested]\n\n[outer]: src/store.ts',
  );
  assert.equal((html.match(/<details>/g) ?? []).length, 2);
  assert.match(html, /data-link="src\/store\.ts"[^>]*>Read<\/a>/);
  assert.match(html, /data-link="src\/inner\.ts"[^>]*>Outside<\/a>/);
  assert.match(html, /data-link="src\/inner\.ts"[^>]*>Deep<\/a>/);
  assert.match(html, /data-link="src\/nested\.ts"[^>]*>After<\/a>/);
  assert.match(html, /<summary[^>]*>Info<\/summary>/);
  assert.doesNotMatch(html, />\[(?:Outside|Read|Deep|After|Info)\]/);
});

test('malformed disclosures and source attributes never create native tags or hide later text', () => {
  const rejected = [
    '<details open><summary>Title</summary>Body</details>',
    '<details name=x><summary>Title</summary>Body</details>',
    '<details style="display:none"><summary>Title</summary>Body</details>',
    '<details onclick="alert(1)"><summary>Title</summary>Body</details>',
    '<details><summary onclick="alert(1)">Title</summary>Body</details>',
    '<details><summary>Title</summary>Body',
    '<summary>Orphan</summary>',
    '<details>Before<summary>Title</summary>Body</details>',
    '<details><summary></summary>Body</details>',
    '<details><summary>First</summary><summary>Second</summary>Body</details>',
    '<details><summary>Title</summary><details><summary>Nested</summary>Body</details>',
    'Inline <details><summary>Title</summary>Body</details>',
    `${'<details>\n<summary>Deep</summary>\n'.repeat(33)}Body\n${'</details>\n'.repeat(33)}`,
  ];
  for (const source of rejected) {
    const html = renderRichMarkdown(`${source}\n\nVisible ending`);
    assert.doesNotMatch(html, /<(?:details|summary)(?:\s|>)/i, source);
    assert.match(html, /Visible ending/, source);
  }
  assert.match(
    renderRichMarkdown(`${'<details>\n<summary>Deep</summary>\n'.repeat(32)}Body\n${'</details>\n'.repeat(32)}`),
    /<details>/,
  );
});

test('literal code and comments never supply disclosure boundaries', () => {
  const tags = '<details><summary>Literal</summary>Body</details>';
  for (const text of [`\`\`\`html\n${tags}\n\`\`\``, `    ${tags}`, `\`${tags}\``, `\\${tags}`, `<!-- ${tags} -->`]) {
    assert.doesNotMatch(renderRichMarkdown(text), /<details>/, text);
  }
  const html = renderRichMarkdown(
    '<details>\n<summary>Outer</summary>\n\n```html\n</details>\n```\n\n`</details>`\n\n<!-- </details> -->\n\n    </details>\n\nVisible body\n</details>',
  );
  assert.equal((html.match(/<details>/g) ?? []).length, 1);
  assert.match(html, /Visible body/);
  assert.match(html, /&lt;\/details&gt;/);
  assert.doesNotMatch(renderInlineMarkdown(tags), /<details>/);
});

test.each([
  ['unordered list', '- ', '  '],
  ['ordered list', '12. ', '    '],
  ['wide ordered list', '123456789) ', '           '],
  ['nested list', '- Parent\n  - ', '    '],
  ['loose list', '- Parent\n\n  ', '  '],
  ['quote', '> ', '> '],
  ['nested quote', '> > ', '> > '],
  ['list quote', '- > ', '  > '],
  ['quoted list', '> - ', '>   '],
  ['task list', '- [ ] ', '  '],
])('%s fences preserve literal disclosure tags and the later outer body', (_name, first, rest) => {
  for (const fence of ['```', '~~~']) {
    for (const tags of ['</details>', '<details><summary>Example</summary>Body</details>']) {
      const source = `<details><summary>Outer</summary>\n\n${first}${fence}html\n${rest}${tags}\n${rest}${fence}\n\nVisible body\n</details>`;
      const html = renderRichMarkdown(source);
      assert.equal((html.match(/<details>/g) ?? []).length, 1, source);
      assert.ok(
        html.includes(`<code class="language-html">${tags.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n</code>`),
        html,
      );
      assert.match(html, /<p>Visible body<\/p>[\s\S]*<\/details>\s*$/, source);
    }
  }
});

test('unclosed container fences end at their container boundary', () => {
  for (const [first, rest] of [
    ['- ', '  '],
    ['12. ', '    '],
    ['> ', '> '],
    ['- > ', '  > '],
    ['> - ', '>   '],
  ]) {
    for (const fence of ['```', '~~~']) {
      const source = `<details><summary>Outer</summary>\n\n${first}${fence}html\n${rest}</details>\n\nVisible body\n</details>`;
      const html = renderRichMarkdown(source);
      assert.equal((html.match(/<details>/g) ?? []).length, 1, source);
      assert.match(html, /<code class="language-html">&lt;\/details&gt;\n<\/code>/, source);
      assert.match(html, /<p>Visible body<\/p>[\s\S]*<\/details>\s*$/, source);
      const unclosed = renderRichMarkdown(
        `<details><summary>Outer</summary>\n\n${first}${fence}html\n${rest}</details>`,
      );
      assert.doesNotMatch(unclosed, /<details>/, source);
      assert.match(unclosed, /&lt;\/details&gt;/, source);
    }
  }
});

test('selected Markdown with a list code block renders back inside its disclosure', () => {
  const html = renderRichMarkdown(
    '<details>\n\n<summary>Outer</summary>\n\n- ```\n  </details>\n  ```\n\nVisible body\n</details>',
  );
  assert.match(html, /<li><pre><code>&lt;\/details&gt;\n<\/code><\/pre>/);
  assert.match(html, /<p>Visible body<\/p>[\s\S]*<\/details>\s*$/);
});

test('inline code containing a comment opener leaves later disclosures active', () => {
  const html = renderRichMarkdown('`<!--`\n\n<details><summary>Info</summary>\nBody\n</details>');
  assert.match(html, /<code>&lt;!--<\/code>/);
  assert.match(html, /<details><summary[^>]*>Info<\/summary>/);
  assert.match(html, /<p>Body<\/p>/);
});

test('escaped backticks around disclosures do not form an inline code span', () => {
  const html = renderRichMarkdown('\\`\n\n<details><summary>Info</summary>\nBody\n</details>\n\n\\`');
  assert.match(html, /<details><summary[^>]*>Info<\/summary>/);
  assert.match(html, /<p>Body<\/p>/);
  assert.doesNotMatch(html, /<code>/);
});

test('fences inside complete comments leave following native disclosures active', () => {
  for (const comment of ['<!--\n```\n-->', 'Before <!--\n\n~~~\n-->']) {
    const html = renderRichMarkdown(`${comment}\n\n<details><summary>Info</summary>\nBody\n</details>`);
    assert.match(html, /<details><summary[^>]*>Info<\/summary>/);
    assert.match(html, /<p>Body<\/p>/);
  }
});

test('unmatched ticks in separate Markdown blocks leave native disclosures active', () => {
  for (const before of ['Before `\n\n', '# Before `\n\n', 'Before `\n---\n\n']) {
    const html = renderRichMarkdown(`${before}<details><summary>Info</summary>\nBody\n</details>\n\nAfter \``);
    assert.match(html, /<details><summary[^>]*>Info<\/summary>/);
    assert.match(html, /<p>Body<\/p>/);
    assert.doesNotMatch(html, /<code>/);
  }
  const literal = renderRichMarkdown('<details><summary>Info</summary>\nBefore `\ninline </details> `\n</details>');
  assert.equal((literal.match(/<details>/g) ?? []).length, 1);
  assert.match(literal, /<code>/);
});

test('disclosure recognition does not change global marked or image and HTML policy', () => {
  const html = renderRichMarkdown(
    '<details><summary>Safe ![picture](https://example.com/p.png)</summary>\n<img src=x onerror=alert(1)>\n\n![Remote](https://example.com/r.png)\n</details>',
  );
  assert.match(html, /<summary[^>]*>Safe picture<\/summary>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-link="https:\/\/example.com\/r.png"/);
});

test('renderInlineMarkdown draws inline marks and no block element', () => {
  const html = renderInlineMarkdown('Ran `npm test` and **all** pass, so _ship it_.');
  assert.match(html, /<code>npm test<\/code>/);
  assert.match(html, /<strong>all<\/strong>/);
  assert.match(html, /<em>ship it<\/em>/);
  assert.doesNotMatch(html, /<p>/);
});

test('renderInlineMarkdown escapes raw HTML the same way the response renderer does', () => {
  const html = renderInlineMarkdown('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('renderInlineMarkdown draws a link as its words with no anchor', () => {
  const html = renderInlineMarkdown('See [store.ts](src/store.ts) for the rest');
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /See store\.ts for the rest/);
});

test('inline session anchors require opt-in and reject ordinary or malformed targets', () => {
  const session = '[**A\\-B**](arc-session:01a137a5-3d93-71d0-9492-965abeb0fa32)';
  assert.doesNotMatch(renderInlineMarkdown(session), /<a /);
  assert.match(
    renderInlineMarkdown(session, undefined, true),
    /data-link="arc-session:[^"]+".*<strong>A-B<\/strong><\/a>/,
  );
  for (const target of [
    'https://example.com',
    'src/file.ts',
    'arc-session:%zz',
    'arc-session:bad/id',
    'arc-visualization:/tmp/chart.html',
  ]) {
    assert.doesNotMatch(renderInlineMarkdown(`[label](${target})`, undefined, true), /<a |<button/);
  }
  assert.doesNotMatch(renderInlineMarkdown('`' + session + '`', undefined, true), /<a /);
  assert.doesNotMatch(renderRichMarkdown(session, undefined, true), /<a /);
});

test('renderInlineMarkdown draws a picture as its alt text with no img', () => {
  assert.equal(renderInlineMarkdown('![a chart](chart.png)'), 'a chart');
  assert.doesNotMatch(renderInlineMarkdown('![](chart.png)'), /<img/);
  assert.match(renderInlineMarkdown('![](chart.png)'), /chart\.png/);
});

test('renderInlineMarkdown draws the same headline twice when it carries an email address', () => {
  // Disable random email encoding so identical headline text produces identical HTML and does not trigger a card redraw.

  const text = 'Reach the on-call at oncall@example.com for the rest.';
  assert.equal(renderInlineMarkdown(text), renderInlineMarkdown(text));
  assert.match(renderInlineMarkdown(text), /oncall@example\.com/);
});

test('renderRichMarkdown draws the same response twice when it carries an email address', () => {
  // Response rendering must retain literal email addresses and produce identical HTML on repeated calls.

  const text = 'Reach the on-call at oncall@example.com for the rest.';
  assert.equal(renderRichMarkdown(text), renderRichMarkdown(text));
  assert.match(renderRichMarkdown(text), /oncall@example\.com/);
});

test('an explicit title names the visualization action', () => {
  assert.match(
    richMarkdown(reference({ title: 'Choose a\n launch flow' })),
    /Open interactive visualization: Choose a launch flow/,
  );
});

test('several visualization references are translated independently', () => {
  const second = path.resolve('fixtures', 'effort-picker.html');
  const drawn = richMarkdown(`${reference()}\n${reference({ path: second })}`);
  assert.equal((drawn.match(/Open interactive visualization:/g) || []).length, 2);
  assert.match(drawn, /Effort picker/);
});

test('a visualization marker inside a fenced example stays literal', () => {
  const example = `\`\`\`text\n${reference()}\n\`\`\``;
  assert.equal(richMarkdown(example), example);
});

test('an invalid visualization reference has a readable fallback', () => {
  for (const marker of [
    '\uE200visualize\uE202not json\uE201',
    `\uE200visualize\uE202${JSON.stringify({ path: 'relative.html' })}\uE201`,
    `\uE200visualize\uE202${JSON.stringify({ path: path.resolve('fixtures', 'notes.txt') })}\uE201`,
  ]) {
    assert.equal(richMarkdown(marker), 'Interactive visualization is unavailable.');
  }
});

test('ordinary prose and inline mentions are not rewritten', () => {
  const inline = `The recorded token was ${reference()}.`;
  assert.equal(richMarkdown(inline), inline);
  assert.equal(richMarkdown('Ordinary Markdown.'), 'Ordinary Markdown.');
});

test('a plain-text surface removes rich-content records without interpreting them', () => {
  assert.equal(withoutRichContent(`Before ${reference()} after`), 'Before   after');
  assert.equal(withoutRichContent(`Keep\n${reference()}\nthis`), 'Keep\n \nthis');
  assert.equal(withoutRichContent('Keep \uE200visualize\uE202truncated'), 'Keep  ');
});

// The host converts images inside the open folder to webview URIs.

const folder = path.resolve('fixtures');
const shot = path.join(folder, 'shot.png');
const markdownShot = shot.replace(/\\/g, '/');
const drawImages = (target: string) => {
  const found = imageFileFor(target, [folder]);
  return found ? { src: `webview://${found.replace(/\\/g, '/')}`, path: found } : null;
};

test('a picture inside an open folder is drawn, and its press opens the file', () => {
  const html = renderRichMarkdown(`![Closed prototype](${markdownShot})`, drawImages);
  assert.match(html, /<button type="button" class="image-link"/);
  assert.ok(html.includes(`data-image="${shot}"`), 'the button carries a different local path');
  assert.match(html, /aria-label="Open image: Closed prototype"/);
  assert.match(html, /<img src="webview:\/\/[^"]*\/shot\.png" alt="Closed prototype">/);
});

test('a relative picture is found under the open folder', () => {
  const html = renderRichMarkdown('![Shot](shot.png)', drawImages);
  assert.ok(html.includes(`data-image="${shot}"`), 'a relative target did not join the open folder');
});

test('a picture the response named with an encoded space is still found', () => {
  const spaced = path.join(folder, 'two words.png');
  const html = renderRichMarkdown('![Shot](two%20words.png)', drawImages);
  assert.ok(html.includes(`data-image="${spaced}"`), 'the encoded space was not decoded');
});

test('a picture outside every open folder draws its words and loads nothing', () => {
  for (const target of [
    path.resolve('elsewhere', 'secret.png'),
    // Resolved before it is tested. This string starts with the open folder, so a prefix
    // test on it passes and the filesystem then walks out of the folder.
    `${folder.replace(/\\/g, '/')}/../secret.png`,
    '../secret.png',
  ]) {
    const html = renderRichMarkdown(`![Secret](${target})`, drawImages);
    assert.doesNotMatch(html, /<img/, `${target} was drawn as a picture`);
    assert.match(html, /Secret/);
  }
});

test('a remote picture draws a link, so nothing is fetched until the reader presses it', () => {
  const html = renderRichMarkdown('![Chart](https://example.com/chart.png)', drawImages);
  assert.doesNotMatch(html, /<img/, 'the panel fetched a remote picture as the card rendered');
  assert.match(html, /<a href="#" data-link="https:\/\/example\.com\/chart\.png">Chart<\/a>/);
});

test('a reference that is not a picture keeps the words the response wrote', () => {
  for (const target of [
    path.join(folder, 'notes.txt'),
    'data:image/png;base64,AAAA',
    path.join(folder, 'report.html'),
  ]) {
    const html = renderRichMarkdown(`![Report](${target})`, drawImages);
    assert.doesNotMatch(html, /<img/, `${target} was drawn as a picture`);
    assert.match(html, /Report/);
  }
});

test('a picture with no alt text is announced by its file name', () => {
  const html = renderRichMarkdown(`![](${markdownShot})`, drawImages);
  assert.match(html, /aria-label="Open image: shot\.png"/);
});

test('an alt text cannot break out of the attribute it is written into', () => {
  const html = renderRichMarkdown(`![" onerror="alert(1)](${markdownShot})`, drawImages);
  assert.doesNotMatch(html, /alt="" onerror=/, 'the alt text closed its own attribute');
  assert.match(html, /alt="&quot; onerror=&quot;alert\(1\)"/);
  assert.doesNotMatch(
    html,
    /&amp;quot;/,
    'the alt text was escaped twice, so the reader reads the escape instead of the words',
  );
});

test('a file whose own name holds a per-cent sign opens on a press', () => {
  // Two different rules meet here. On the way in the target is Markdown, where `%20` is a
  // space. On the way back it is the file name the renderer already resolved, where a
  // per-cent sign is part of the name and decoding it opens a different file.
  const odd = path.join(folder, 'plan%20b.png');
  assert.equal(imagePathFor(odd, [folder]), odd);
  assert.equal(imageFileFor(odd, [folder]), path.join(folder, 'plan b.png'));
  assert.equal(
    imagePathFor(path.resolve('elsewhere', 'secret.png'), [folder]),
    null,
    'the press path skips the workspace rule',
  );
});

test('a link keeps its own press, whatever pictures its body holds', () => {
  // Each of these puts a control inside an anchor if the body is written through unchanged.
  // A button there is invalid and takes a tab stop of its own. An anchor there is closed by
  // the parser at the inner tag, which empties the link the response wrote.
  const bodies = [
    `![Shot](${markdownShot})`,
    `![Shot](${markdownShot}) caption`,
    `caption ![Shot](${markdownShot})`,
    `![A](${markdownShot}) read more ![B](${markdownShot})`,
    '![Chart](https://example.com/chart.png)',
    '![Chart](https://example.com/chart.png) and words',
  ];
  for (const body of bodies) {
    const html = renderRichMarkdown(`[${body}](src/store.ts)`, drawImages);
    assert.equal(
      (html.match(/<a /g) || []).length,
      1,
      `"${body}" as a link draws more than the one anchor the response wrote`,
    );
    assert.doesNotMatch(html, /<a[^>]*>[\s\S]*<button/, `"${body}" as a link puts a button inside it`);
    assert.match(
      html,
      /<a href="#" data-link="src\/store\.ts">/,
      `"${body}" as a link lost the target the response wrote`,
    );
  }
  // The words beside a picture stay inside the link rather than falling out of it.
  assert.match(
    renderRichMarkdown(`[![A](${markdownShot}) read more ![B](${markdownShot})](src/store.ts)`, drawImages),
    /read more/,
  );
  // A link whose body is words is untouched by the same rule.
  assert.match(
    renderRichMarkdown('[Read](src/store.ts)', drawImages),
    /<a href="#" data-link="src\/store\.ts">Read<\/a>/,
  );
});

test('a picture on its own still draws the button that opens it', () => {
  const html = renderRichMarkdown(`![Shot](${markdownShot})`, drawImages);
  assert.match(html, /<button type="button" class="image-link"/);
  assert.match(html, /<img src="webview:\/\//);
});

test('a link title is written once, so the reader reads the title and not its escape', () => {
  const html = renderRichMarkdown('[Read](a.md "one & two")', drawImages);
  assert.match(html, /title="one &amp; two"/);
  assert.doesNotMatch(html, /&amp;amp;/, 'the link title was escaped twice');
});

test('a caller with no webview draws every picture as words', () => {
  const html = renderRichMarkdown(`![Closed prototype](${markdownShot})`);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /Closed prototype/);
});

test('only a response that names a picture is rendered again for one host', () => {
  assert.equal(hasImageReference(`![Shot](${markdownShot})`), true);
  assert.equal(hasImageReference('Ordinary prose with a [link](a.md) in it.'), false);
  assert.equal(hasImageReference(''), false);
});

test('only valid visualization hrefs return a path', () => {
  assert.equal(visualizationPath('https://example.com/view.html'), null);
  assert.equal(visualizationPath(VISUALIZATION_SCHEME + '%broken'), null);
  assert.equal(visualizationPath(VISUALIZATION_SCHEME + encodeURIComponent('relative.html')), null);
  assert.equal(
    visualizationPath(VISUALIZATION_SCHEME + encodeURIComponent(path.resolve('fixtures', 'notes.txt'))),
    null,
  );
});

test('a link to a picture is opened by the viewer and not by the text editor', () => {
  for (const target of ['board.png', 'BOARD.PNG', 'a/b/shot.webp', 'photo.jpeg', 'icon.svg']) {
    assert.equal(linkTargetIsImage(target), true, `${target} was sent to the text editor`);
  }
  for (const target of ['notes.md', 'panel.css', 'report.html', 'pngs', 'a.png.txt', '']) {
    assert.equal(linkTargetIsImage(target), false, `${target} was sent to the picture viewer`);
  }
});
