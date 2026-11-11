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
