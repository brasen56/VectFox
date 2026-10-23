import { readFile } from 'node:fs/promises';
import { measureEpisodeBaseline } from '../core/episode-baseline.js';

try {
    if (process.argv.length !== 3) throw new Error('Usage: npm run measure:episodes -- <review-bundle.json>');
    const report = measureEpisodeBaseline(JSON.parse(await readFile(process.argv[2], 'utf8')));
    console.log(JSON.stringify(report, null, 2));
    if (!report.complete) process.exitCode = 2;
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}