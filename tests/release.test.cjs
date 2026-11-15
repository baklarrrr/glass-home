'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
test('refuse a worker-only or JS-only release under an existing number; verify immutable bytes',()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'home-release-test-'));
 const command=(exe,args)=>cp.spawnSync(exe,args,{cwd:dir,encoding:'utf8'});
 const verify=(mode)=>command(process.execPath,['tools/prepare-release.cjs',mode]);
 try{
  fs.cpSync(root,dir,{recursive:true,filter:p=>!['.git','node_modules'].includes(path.basename(p))});
  assert.equal(command('git',['init','--quiet']).status,0);
  assert.equal(command('git',['add','.']).status,0);
  assert.equal(command('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','--quiet','-m','baseline']).status,0);
  assert.equal(verify('--check').status,0);
  for(const file of ['sw.js','drive/app.js']){
   const dest=path.join(dir,file),before=fs.readFileSync(dest);
   fs.appendFileSync(dest,'\n// Simulated change.\n');
   assert.notEqual(verify('--check').status,0,file);
   assert.notEqual(verify('--write').status,0,'must bump version for '+file);
   fs.writeFileSync(dest,before);
  }
  const release=JSON.parse(fs.readFileSync(path.join(dir,'release.json')));release.build++;
  fs.writeFileSync(path.join(dir,'release.json'),JSON.stringify(release));
  assert.notEqual(verify('--check').status,0);
  assert.equal(verify('--write').status,0);assert.equal(verify('--check').status,0);
  const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
  const entry=html.match(/src="(runtime\/home-v[^"]+)"/)[1];
  fs.appendFileSync(path.join(dir,entry),'\n// wrong bytes');
  assert.notEqual(verify('--check').status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// ---- build 51: the Battery app's logger is an optional extra, never part of what the app needs to open ----
test('battery logger: one async line after the app entry on both apps; never precached, kept once fetched',()=>{
  const fs=require('node:fs'),path=require('node:path'),at=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
  for(const [page,name,worker] of [['index.html','Bakar Home','sw.js'],['drive/index.html','Bakar Drive','drive/sw.js']]){
    const html=at(page),line=`<script async src="/battery-glass/battery-log.js" data-app="${name}"></script>`;
    assert.equal(html.split(line).length,2,page+': the line is there once');
    assert.ok(html.indexOf(line)>html.indexOf('<!-- end-app-entry -->'),page+': after the app, which never waits for it');
    const sw=at(worker),shell=sw.match(/const SHELL = \[[^\]]*\]/)[0];
    assert.ok(!/battery/.test(shell),worker+': not in the install list, so a missing logger cannot stop the app installing');
    assert.match(sw,/url\.pathname === '\/battery-glass\/battery-log\.js'/,worker+': fetched through the worker and kept for offline');
    assert.match(sw,/\|\| Response\.error\(\)/);
  }
});
