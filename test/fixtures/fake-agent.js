// Stands in for `claude -p`: receives the wake prompt as last arg and replies via the hub.
import { Hub, loadConfig } from '../../src/client.js';
const prompt = process.argv.at(-1);
const hub = new Hub(loadConfig());
const b = await hub.brief();
for (const q of b.asked_of_you.questions) await hub.send(`answering: ${q.body.length}`, { reply_to: q.id, type: 'answer' });
for (const p of b.asked_of_you.proposals_to_vote) await hub.vote(p.id, 'agree', 'looks right to me');
console.log('handled', prompt.includes('[Convorum wake-up]'));
