import {execFileSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
const findings=[];
for(const repo of [process.cwd(),path.resolve('../DSU-WEB')]){
  const files=execFileSync('git',['ls-files','-z'],{cwd:repo,encoding:'utf8'}).split('\0').filter(Boolean);
  for(const name of files){
    if(/(?:^|\/)(?:node_modules|\.next|\.qa|\.local)(?:\/|$)|\.(?:png|jpe?g|webp|avif|gif|woff2?|ico|pdf|mp4)$/i.test(name))continue;
    if(/(?:^|\/)\.env(?:\.|$)/.test(name)&&!/^\.env(?:\..+)?\.example$|^\.env\.example$/.test(path.basename(name)))findings.push({repo:path.basename(repo),file:name,reason:'Non-template environment tracked'});
    let source;try{if(statSync(path.join(repo,name)).size>2000000)continue;source=readFileSync(path.join(repo,name),'utf8');}catch{continue;}
    for(const [label,regex] of Object.entries({privateKey:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,githubToken:/\b(?:gh[pousr]_[a-zA-Z0-9]{32,}|github_pat_[a-zA-Z0-9_]{40,})\b/,providerKey:/\bsk-or-v1-[a-f0-9]{32,}\b/,awsKey:/\bAKIA[0-9A-Z]{16}\b/}))if(regex.test(source))findings.push({repo:path.basename(repo),file:name,reason:label});
  }
}
console.log(JSON.stringify({scanned:'All tracked and staged files in both repositories; ignored local envs excluded',findings}));
if(findings.length)process.exitCode=1;
