// The "local incubators" go-to-market strategy, and the GitHub repos read for Skills.
const description = `Who: local incubators and accelerators, through their programme directors and community managers.

Pitch: FLF is a fellowship for founders, focused on the founder as a person (wellbeing, wealth, community). It complements the business support the incubator already gives.

Offer: a limited number of invitations for the incubator's founders to join FLF. Scarce on purpose: the incubator chooses which founders to nominate, which makes the invitation a benefit it can offer its best founders.

How we reach them: a direct, personal approach to the programme lead (warm intro where possible, otherwise email or LinkedIn), then a short call to explain FLF and agree the number of invitations and how nominations work.

Success: the incubator agrees to nominate founders, and the invited founders apply and join FLF.

To decide: how many invitations per incubator, which cities first, and whether invitations expire.`;

export default async function (db, FieldValue) {
	const now = FieldValue.serverTimestamp();
	await db.collection('strategy').doc('local-incubators').set({
		name: 'Local incubators – limited invitations',
		segment: 'accelerator',
		status: 'active',
		description,
		updatedBy: 'Vicente Vidal',
		updatedAt: now,
		createdAt: now
	});
	await db
		.collection('connection')
		.doc('skills-github')
		.set({ settings: { repos: 'vicente266/FLF\nvicente266/FLF-Content' } }, { merge: true });
	return 'strategy local-incubators saved; skills-github repos set';
}
