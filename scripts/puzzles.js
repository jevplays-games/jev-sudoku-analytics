import{randomBytes}from'node:crypto';import{generatePuzzle}from'./puzzle-lib.js';import{openDb}from'../server/db.js';import{loadConfig}from'../server/config.js';import{hash}from'../server/security.js';
const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];};
const date=arg('date',new Date().toISOString().slice(0,10)),days=Number(arg('days','7'));
if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||!Number.isInteger(days)||days<1||days>366)throw Error('Use --date YYYY-MM-DD --days 1..366');
const config=loadConfig(),db=openDb(config.database);let created=0;
try{for(let day=0;day<days;day++)for(const difficulty of ['easy','normal','hard','jev']){
  const utcDate=new Date(Date.parse(date+'T00:00:00Z')+day*86400000).toISOString().slice(0,10);
  if(db.prepare('SELECT 1 FROM challenges WHERE utc_date=? AND difficulty=?').get(utcDate,difficulty))continue;
  const seed=randomBytes(32).toString('hex'),p=generatePuzzle(seed),id=`sudoku:${utcDate}:${difficulty}`;
  db.prepare('INSERT INTO challenges(id,utc_date,difficulty,givens,puzzle_hash,private_seed,config_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,utcDate,difficulty,p.givens,hash(p.givens),seed,
    JSON.stringify({difficulty,mode:'ranked',model:config.jevModel,pacingMs:8000,timeLimitMs:3600000,puzzleBand:'standard-v1',generatorVersion:p.generatorVersion,policyVersion:'sudoku-policy-v1'}),Date.now());
  created++;console.log(JSON.stringify({event:'challenge_published',id,clues:p.actualClues,model:config.jevModel}));
}}finally{db.close();}console.log(`Published ${created} new challenges. Existing challenges were not overwritten.`);
