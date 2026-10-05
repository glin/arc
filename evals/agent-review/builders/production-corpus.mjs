import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
export async function buildBugs({ repo, suite, scratch }) {
  const req = createRequire(repo + '/extension/package.json');
  const esbuild = req('esbuild'),
    ts = req('typescript');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const cache = new Map();
  const read = (rev, p) => {
    const key = rev + ':' + p;
    if (!cache.has(key)) cache.set(key, git('show', key).toString());
    return cache.get(key);
  };
  const resolve = (rev, from, spec) => {
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    const key = rev + ':tree';
    if (!cache.has(key)) cache.set(key, git('ls-tree', '-r', '--name-only', rev).toString().split('\n'));
    const names = cache.get(key);
    return [p, p + '.ts', p + '.js', p + '/index.ts'].find((x) => names.includes(x));
  };
  const selectedTests = (rev, p, patterns) => {
    let source = read(rev, p);
    if (rev.startsWith('b6dfad6') && p.endsWith('panel.webview.test.ts')) {
      const parsed = ts.createSourceFile(p, source, ts.ScriptTarget.Latest, true);
      const fn = parsed.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'stateForRow');
      const text = fn.getText(parsed);
      const host = text.slice(text.indexOf('  const host ='), text.indexOf('  return read.call'));
      const body =
        host
          .replace('    cwdForSession,', '    cwdForSession: PanelProvider.prototype.cwdForSession,')
          .replace('    ownCwdForSession,', '    ownCwdForSession: PanelProvider.prototype.ownCwdForSession,')
          .replace('    claudeCommandsFor,', '    claudeCommandsFor: PanelProvider.prototype.claudeCommandsFor,') +
        `return PanelProvider.prototype.stateForRow.call(host, rows.find(row=>row.id===id));`;
      source =
        source.slice(0, fn.getStart(parsed)) +
        text.slice(0, fn.body.getStart(parsed) - fn.getStart(parsed)) +
        '{\n' +
        body +
        '\n}' +
        source.slice(fn.end);
    }
    const ast = ts.createSourceFile(p, source, ts.ScriptTarget.Latest, true);
    const decls = new Map(),
      imports = new Map(),
      selected = [];
    for (const s of ast.statements) {
      if (ts.isImportDeclaration(s) && s.importClause) {
        if (s.importClause.name) imports.set(s.importClause.name.text, { s, p: s.moduleSpecifier.text });
        const b = s.importClause.namedBindings;
        if (b && ts.isNamespaceImport(b)) imports.set(b.name.text, { s, p: s.moduleSpecifier.text });
        if (b && ts.isNamedImports(b))
          for (const e of b.elements) if (!e.isTypeOnly) imports.set(e.name.text, { s, p: s.moduleSpecifier.text });
      }
      if (ts.isFunctionDeclaration(s) && s.name) decls.set(s.name.text, s);
      if (ts.isVariableStatement(s))
        for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) decls.set(d.name.text, s);
      if (ts.isExpressionStatement(s) && patterns.some((x) => s.getText(ast).includes(x))) selected.push(s);
    }
    if (selected.length !== patterns.length) throw Error(`test selection ${p} ${selected.length}/${patterns.length}`);
    const needed = new Set(),
      used = new Set(),
      queue = [...selected];
    while (queue.length) {
      const s = queue.pop();
      const visit = (n) => {
        if (ts.isTypeNode(n)) return;
        if (ts.isIdentifier(n)) {
          const parent = n.parent;
          const property =
            (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
            (ts.isPropertyAssignment(parent) && parent.name === n) ||
            ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === n);
          if (!property) {
            const name = n.text;
            if (imports.has(name)) used.add(name);
            if (decls.has(name) && name !== 'PanelProvider' && !needed.has(name)) {
              needed.add(name);
              queue.push(decls.get(name));
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(s);
    }
    const imp = [...new Set([...used].map((n) => imports.get(n).s))];
    const dependencies = imp
      .filter((s) => s.moduleSpecifier.text.startsWith('.'))
      .map((s) => resolve(rev, p, s.moduleSpecifier.text));
    const helpers = [...new Set([...needed].map((n) => decls.get(n)))]
      .sort((a, b) => a.pos - b.pos)
      .map((s) => s.getText(ast))
      .join('\n');
    const importText = (s) => {
      const clause = s.importClause,
        b = clause.namedBindings;
      if (b && ts.isNamedImports(b)) {
        const names = b.elements.filter((e) => used.has(e.name.text) && !e.isTypeOnly).map((e) => e.getText(ast));
        return `import {${names.join(',')}} from ${s.moduleSpecifier.getText(ast)};`;
      }
      return s.getText(ast);
    };
    return {
      source: imp.map(importText).join('\n') + '\n' + helpers + '\n' + selected.map((s) => s.getText(ast)).join('\n'),
      dependencies,
    };
  };
  const viSource = `const jobs=[],checks=[]; export const test=(name,fn)=>jobs.push({name,fn}); test.each=values=>(name,fn)=>{for(const v of values)test(name,()=>fn(...(Array.isArray(v)?v:[v])))}; export const describe=(_name,fn)=>fn(); export const vi={waitFor:async(fn)=>{const end=Date.now()+2000;while(true){try{return fn()}catch(e){if(Date.now()>end)throw e;await new Promise(resolve=>setImmediate(resolve))}}},spyOn:(object,key)=>{const old=object[key];return {mockImplementation(fn){object[key]=fn;return this},mockRestore(){object[key]=old}}}}; export async function finish(){for(let i=0;i<jobs.length;i++){let pass=true;try{await jobs[i].fn()}catch(e){console.error(e.stack);pass=false}checks.push({id:'check-'+i,role:jobs[i].name.startsWith('ordinary')?'normal':'symptom',pass})}console.log(JSON.stringify({checks}))}`;
  const cases = [
    {
      id: 24,
      fix: 'bc896125191dc9283e332edbb6864d6bcbf93892',
      candidate: 'd47bbb0863a1b52898e400b86854a008f3dbc1b3',
      entry: 'extension/src/panelhost.ts',
      test: 'extension/src/panel.webview.test.ts',
      patterns: ['submitted recovery freezes comment membership across queue note edit at'],
    },
    {
      id: 25,
      fix: 'd4d9893613ed1c9bd033d2eb72b018cfd1052d44',
      candidate: '935b3d7ce6bee2be37f6ac55c51c2574a176ccb8',
      entry: 'extension/src/projectspend.ts',
      test: 'extension/src/projectspend.test.ts',
      patterns: ['newline followed by NUL padding indexes an appended line the same after a rebuild'],
    },
    {
      id: 26,
      fix: 'b6dfad6ecbf188c13ad39be7da7c753b02d4a3b2',
      candidate: '7a19278064962990cd45e237a8048cbb25444d5a',
      entry: 'extension/src/panelhost.ts',
      test: 'extension/src/panel.webview.test.ts',
      patterns: ['the first reader child selection includes its parent (recovery'],
    },
    {
      id: 27,
      fix: '1410b2bd9832d173eb2055d140b20a603527f5d3',
      candidate: 'bca6b2770f8b321a130314d6dda77200b55f2954',
      entry: 'extension/src/composerview.ts',
      test: 'extension/src/composerview.test.ts',
      patterns: ['omitted models keep supported effort through metadata changes and adoption'],
    },
  ];
  const runtimeEntries = {};
  fs.writeFileSync(scratch + '/vi.mjs', viSource);
  for (const c of cases) {
    const id = `portable-${c.id.toString().padStart(3, '0')}`,
      fixture = suite + '/fixtures/' + id;
    fs.mkdirSync(fixture, { recursive: true });
    const chosen = selectedTests(c.fix, c.test, c.patterns);
    const production = chosen.dependencies.filter(
      (p) =>
        p &&
        !p.includes('turnfixtures') &&
        !p.includes('temproot') &&
        !p.includes('/test/') &&
        !p.includes('/scripts/'),
    );
    production.push(c.entry, 'extension/src/turnview.ts');
    if (c.id === 24 || c.id === 26) production.push('extension/src/composerview.ts');
    if (c.id === 24 || c.id === 26) production.push('extension/src/panelhost.ts');
    const paths = [...new Set(production)];
    let qualifier = chosen.source;
    if (c.id === 25)
      qualifier = qualifier
        .replace(/assert.equal\((?:indexed|loaded)\.(?:offset|trailing|trailingBytes),[^;]+;/g, '')
        .replace(
          /assert.deepEqual\(\s*prepareProjectSpendView\(\[loaded\][\s\S]*?\);\s*fs.appendFileSync/,
          'fs.appendFileSync',
        );
    qualifier = qualifier.replace(/import\s+\{([^}]+)\}\s+from\s+['"]vitest['"];?/g, "import {$1} from 'vitest';");
    qualifier =
      `import {createRequire} from 'node:module'; import {finish} from 'vitest'; const require=createRequire(import.meta.url); const ROOT=process.argv[2]; const RUNTIME=require(ROOT+'/runtime.cjs');\n` +
      qualifier;
    qualifier = qualifier.replace(/import[^;]+from ['"]([^'"]+)['"];?/g, (line, spec) => {
      if (!spec.startsWith('.')) return line;
      const resolved = resolve(c.fix, c.test, spec);
      if (!paths.includes(resolved)) return line;
      const clause = line
        .slice(6, line.indexOf('from'))
        .trim()
        .replace(/\btype\s+\w+,?\s*/g, '');
      if (clause.startsWith('{'))
        return `const ${clause.replace(/\bas\b/g, ':')}=RUNTIME.modules[${JSON.stringify(resolved)}];`;
      if (clause.startsWith('* as ')) return `const ${clause.slice(5)}=RUNTIME.modules[${JSON.stringify(resolved)}];`;
      throw Error('import clause ' + clause);
    });
    if (c.id === 24 || c.id === 26)
      qualifier += `\nconst PanelProvider=RUNTIME.modules['extension/src/panelhost.ts'].PanelProvider;`;
    if (c.id === 24)
      qualifier += `\ntest('ordinary delivery and refusal',()=>{const fn=RUNTIME.modules['extension/src/composerview.ts'].commentsAfterSend;const sent={id:'one',note:'note',at:1,turnKey:'source:1',part:'summary',quote:'',headline:'Turn',sessionTitle:'Source',turnAt:1};const other={...sent,id:'two'};assert.deepEqual(fn([sent,other],[{...sent}],true),[other]);assert.deepEqual(fn([sent,other],[sent],false),[sent,other]);assert.deepEqual(fn([sent],[],true),[sent]);});`;
    if (c.id === 25)
      qualifier += `\ntest('ordinary append and incomplete boundary',()=>{const folder=dir(),file=path.join(folder,'ordinary.jsonl');const first=JSON.stringify(event(stamp('2026-09-23T10:00:00'),{reportedCost:2}))+'\\n';fs.writeFileSync(file,first);const initial=indexSpendFile(undefined,file,'one',reducer,1).record;fs.appendFileSync(file,JSON.stringify(event(stamp('2026-09-29T10:00:00'),{reportedCost:3}))+'\\n');const next=indexSpendFile(initial,file,'one',reducer,2).record;assert.equal(next.buckets.reduce((sum,b)=>sum+b.requests,0),2);assert.deepEqual(next.buckets,indexSpendFile(undefined,file,'one',reducer,3).record.buckets);for(const tail of ['{',String.fromCharCode(0,0)+'{']){fs.writeFileSync(file,first+tail);const partial=indexSpendFile(undefined,file,'one',reducer,4).record;assert.equal(partial.offset,Buffer.byteLength(first));assert.equal(partial.trailingBytes,Buffer.from(tail).toString('base64'));}});`;
    if (c.id === 26)
      qualifier += `\ntest('ordinary New leaves no reader parent',()=>{const f=pendingModelLauncher();const p=f.provider;const created=[];p.attachmentRecoveryPending=()=>false;p.launcherFor=()=>({owner:f.owner,state:null,view:RUNTIME.modules['extension/src/composerview.ts'].sessionLauncherView(null,[],{claude:p.models.claude})});p.createDraft=(...args)=>created.push(args);const request={kind:'custom',agent:'claude',model:'opus',effort:'high',permissionMode:''};assert.equal(p.newSession(request,f.owner),true);assert.equal(created.length,1);assert.notEqual(created[0][7],true);assert.deepEqual(p.saved.readerParents,{});assert.equal(p.newSession({...request,model:'retired'},f.owner),false);});`;
    if (c.id === 27)
      qualifier += `\ntest('ordinary explicit model and retired effort',()=>{const models=[{value:'model',resolvedModel:'model-identity',label:'Model',description:'',efforts:[{value:'high',label:'High',description:''}]}];for(const agent of ['claude','codex']){const view=sessionLauncherView(null,[],{[agent]:models});const request={kind:'custom',agent,model:'model',effort:'high',permissionMode:''};assert.equal(launcherProfile(view,request)?.effort,'high');assert.equal(launcherProfile(view,{...request,effort:'retired'}),null);assert.equal(launcherProfile(view,{...request,model:'missing'}),null);}});`;
    qualifier += `\nawait finish();`;
    const collected = {};
    for (const [side, rev] of [
      ['input', c.candidate],
      ['reference', c.fix],
    ]) {
      const folder = fixture + '/' + side;
      fs.mkdirSync(folder, { recursive: true });
      const sourceEntry =
        paths.map((p, i) => `import * as m${i} from './${p}';`).join('\n') +
        `\nexport const modules={${paths.map((p, i) => JSON.stringify(p) + ':m' + i).join(',')}};`;
      const plugin = {
        name: 'historical',
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: scratch + '/vscode.ts' }));
          build.onResolve({ filter: /^\./ }, (args) => {
            if (args.namespace === 'history' || args.importer.endsWith('entry.ts')) {
              const found = resolve(rev, args.namespace === 'history' ? args.importer : 'entry.ts', args.path);
              if (found) return { path: found, namespace: 'history' };
            }
            return undefined;
          });
          build.onLoad({ filter: /.*/, namespace: 'history' }, (args) => {
            const contents = read(rev, args.path);
            collected[side] ??= {};
            collected[side][args.path] = contents;
            return { contents, loader: args.path.endsWith('.ts') ? 'ts' : 'js', resolveDir: repo + '/extension' };
          });
        },
      };
      const result = await esbuild.build({
        stdin: { contents: sourceEntry, sourcefile: 'entry.ts', resolveDir: repo },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        plugins: [plugin],
        legalComments: 'none',
        minifyWhitespace: true,
        define: { PANEL_CSS: '""', PANEL_JS: '""', PANEL_DEV_SERVER_URL: 'null' },
        logLevel: 'silent',
      });
      fs.writeFileSync(folder + '/runtime.cjs', result.outputFiles[0].contents);
    }
    const allPaths = [...new Set([...Object.keys(collected.input), ...Object.keys(collected.reference)])];
    for (const side of ['input', 'reference'])
      for (const p of allPaths) {
        const dest = fixture + '/' + side + '/' + p;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, collected[side][p] ?? read(side === 'input' ? c.candidate : c.fix, p));
      }
    const qualifierPlugin = {
      name: 'qualification',
      setup(build) {
        build.onResolve({ filter: /^vitest$/ }, () => ({ path: scratch + '/vi.mjs' }));
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: scratch + '/vscode.ts' }));
        build.onResolve({ filter: /^\./ }, (a) => {
          if (a.importer.endsWith('qualifier.ts') || a.namespace === 'history') {
            const found = resolve(c.fix, a.namespace === 'history' ? a.importer : c.test, a.path);
            if (found) return { path: found, namespace: found.includes('temproot') ? 'teststub' : 'history' };
          }
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: 'teststub' }, () => ({
          contents: `import fs from 'node:fs';import os from 'node:os';import path from 'node:path';export const tempDir=prefix=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),prefix));(globalThis.qualificationDirs??=[]).push(directory);return directory}`,
          loader: 'js',
        }));
        build.onLoad({ filter: /.*/, namespace: 'history' }, (a) => ({
          contents: read(c.fix, a.path),
          loader: 'ts',
          resolveDir: repo + '/extension',
        }));
      },
    };
    fs.writeFileSync(scratch + '/' + id + '-qualifier.ts', qualifier);
    qualifier += `\nfor(const directory of globalThis.qualificationDirs??[])require('node:fs').rmSync(directory,{recursive:true,force:true});`;
    const q = await esbuild.build({
      stdin: { contents: qualifier, sourcefile: 'qualifier.ts', loader: 'ts', resolveDir: repo },
      plugins: [qualifierPlugin],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      legalComments: 'none',
      logLevel: 'silent',
    });
    fs.writeFileSync(fixture + '/qualify.mjs', q.outputFiles[0].text.replace(/^\/\/ .*$/gm, ''));
    runtimeEntries[id] = paths;
  }
  return runtimeEntries;
}

export async function buildControls({ repo, suite }) {
  const req = createRequire(repo + '/extension/package.json'),
    esbuild = req('esbuild');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 64 * 1024 * 1024 }),
    read = (rev, p) => git('show', rev + ':' + p).toString();
  for (const c of [
    { id: 28, rev: '3715b6d2517f2f5e1c6bb8cc888de30e204745e3' },
    {
      id: 29,
      rev: 'fe00298b948a685411681c201e1a7ab1727db865',
      family: 'cross-platform-diagnostics',
      entry: 'scripts/capture-panel-diagnostics.js',
      title: 'Diagnostic capture',
    },
  ]) {
    const id = 'portable-' + c.id.toString().padStart(3, '0'),
      fixture = suite + '/fixtures/' + id,
      folder = fixture + '/input';
    fs.mkdirSync(folder, { recursive: true });
    const files = {};
    if (c.id === 28) {
      const names = git('ls-tree', '-r', '--name-only', c.rev).toString().split('\n');
      const plugin = {
        name: 'export',
        setup(b) {
          b.onResolve({ filter: /^\./ }, (a) => {
            const raw = path.posix.normalize(
              path.posix.join(a.namespace === 'history' ? path.posix.dirname(a.importer) : 'cli/src', a.path),
            );
            const found = [raw, raw + '.ts', raw + '/index.ts'].find((p) => names.includes(p));
            if (found) return { path: found, namespace: 'history' };
            return undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'history' }, (a) => ({
            contents: (files[a.path] ??= read(c.rev, a.path)),
            loader: 'ts',
            resolveDir: repo + '/extension',
          }));
        },
      };
      const built = await esbuild.build({
        stdin: { contents: "import './main.ts';", sourcefile: 'entry.ts', resolveDir: repo },
        plugins: [plugin],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        minifyWhitespace: true,
        legalComments: 'none',
        define: { ARC_VERSION: '"0.1.0"' },
      });
      fs.writeFileSync(folder + '/runtime.cjs', built.outputFiles[0].contents);
      files['cli/package.json'] = read(c.rev, 'cli/package.json');
    } else {
      files[c.entry] = read(c.rev, c.entry);
      files['scripts/capture-panel-diagnostics.ps1'] = read(c.rev, 'scripts/capture-panel-diagnostics.ps1');
    }
    for (const [p, bytes] of Object.entries(files)) {
      const dest = folder + '/' + p;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
    }
    fs.cpSync(folder, fixture + '/reference', { recursive: true });
    let qualifier;
    if (c.id === 28)
      qualifier = `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';const root=process.argv[2],checks=[];const test=(id,role,fn)=>{let pass=true;try{fn()}catch{pass=false}checks.push({id,role,pass})};const run=(args,input)=>spawnSync(process.execPath,[path.join(root,'runtime.cjs'),...args],{input,encoding:'utf8'});test('aliases','symptom',()=>{const item=JSON.parse(fs.readFileSync(path.join(root,'cli/package.json')));assert.equal(item.bin.arc,item.bin['arc-status']);const output=run(['--help']);assert.equal(output.status,0);assert.match(output.stdout,/Usage: arc statusline/);assert.match(output.stdout,/arc cost TARGET/)});test('normal-version','normal',()=>{assert.equal(run(['--version']).stdout.trim(),'0.1.0')});test('normal-status','normal',()=>{const output=run(['statusline','--json'],JSON.stringify({model:{id:'claude-opus-5'},context_window:{context_window_size:1000000,total_input_tokens:1,total_output_tokens:1}}));assert.equal(output.status,0);assert.equal(typeof JSON.parse(output.stdout),'object')});test('normal-invalid','normal',()=>{assert.notEqual(run(['missing']).status,0);assert.notEqual(run(['statusline'],'').status,0)});console.log(JSON.stringify({checks}));`;
    else {
      const source = read(c.rev, 'scripts/capture-panel-diagnostics.test.js');
      qualifier =
        `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const __dirname=process.argv[2]+'/scripts';const jobs=[],checks=[];let cleanup;globalThis.test=(name,fn)=>jobs.push({name,fn});globalThis.afterEach=fn=>cleanup=fn;process.env.ARC_DIAGNOSTICS_TEST_SCRIPT=__dirname+'/capture-panel-diagnostics.js';\n` +
        source +
        `\nfor(let i=0;i<jobs.length;i++){let pass=true;try{await jobs[i].fn()}catch{pass=false}finally{cleanup?.()}checks.push({id:'capture-'+i,role:i===0?'symptom':'normal',pass})}console.log(JSON.stringify({checks}));`;
    }
    fs.writeFileSync(fixture + '/qualify.mjs', qualifier);
  }
}
