'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert'),os=require('os'),cp=require('child_process');
const root=path.resolve(__dirname,'..'),manifest=require('./manifest.json');
assert.equal(manifest.controls.length,5);assert.equal(manifest.styles.length,3);
const generated=fs.mkdtempSync(path.join(os.tmpdir(),'icarui-next-'));
cp.execFileSync(process.execPath,[path.join(__dirname,'generate.js'),generated]);
assert.equal(fs.readFileSync(path.join(generated,'next-library/manifest.json'),'utf8'),fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
for(const a of manifest.assets){
 assert(a.path.startsWith('assets/next/v1/')&&!a.path.includes('..'));
 const b=fs.readFileSync(path.join(root,a.path));assert(b.equals(Buffer.from(a.data.split(',')[1],'base64')));
 assert.equal(crypto.createHash('sha256').update(b).digest('hex'),a.sha256);
 assert.equal(b.readUInt32BE(16),256);assert.equal(b.readUInt32BE(20),256);
 assert(b.equals(fs.readFileSync(path.join(generated,a.path))));
}
console.log('PASS: 5 semantics, 15 variants, 3 PNG byte/hash/dimension/replay checks');
// Keep the tiny replay directory as reproducibility evidence; no recursive cleanup.
