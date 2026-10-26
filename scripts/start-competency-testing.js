import {competencyEnabled} from '../src/modules/competency/gate.js';
if(!competencyEnabled(process.env))throw new Error('Testing runtime must target bsiibnoqfuyxieogions with COMPETENCY_TESTING=true.');
if(process.env.SYNC_WORKER!=='off')throw new Error('External platform synchronization must be off for synthetic students.');
await import('../src/server.js');
