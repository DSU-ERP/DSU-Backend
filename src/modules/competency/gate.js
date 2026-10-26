import {databaseProjectRef,parseDatabaseUrl,projectRef} from '../../platform/devguard.js';
import {TESTING_PROJECT_REF} from '../../platform/testing-guard.js';
export function competencyEnabled(env){
 return env.COMPETENCY_TESTING==='true' && env.DSU_ENVIRONMENT==='testing' && projectRef(env.SUPABASE_URL)===TESTING_PROJECT_REF && databaseProjectRef(parseDatabaseUrl(env.DATABASE_URL))===TESTING_PROJECT_REF;
}
