import { defineConfig } from 'checkly';
import { Frequency } from 'checkly/constructs';

export default defineConfig({
	projectName: 'FLF Hub',
	logicalId: 'flf-hub',
	repoUrl: 'https://github.com/vicente266/FLF-HUB',
	checks: {
		// Hourly from one place keeps the browser check inside the free Hobby plan.
		frequency: Frequency.EVERY_1H,
		locations: ['eu-west-1'],
		checkMatch: '**/*.check.js'
	},
	cli: { runLocation: 'eu-west-1' }
});
