import type { AppContext } from '../context';

/**
 * Resolve where call recordings / SMS / notes attach for a given contact.
 * Honors ATTACH_TARGET ('job' default, 'contact', or 'both'). Returns:
 *  - ATTACH_TARGET=contact         → [contact]
 *  - ATTACH_TARGET=both            → [contact, ...all related jobs]
 *  - ATTACH_TARGET=job (default)   → all related jobs, falling back to [contact]
 *                                    when the contact has no jobs yet
 */
export async function resolveAttachTargets(
  ctx: AppContext,
  contactJnid: string,
): Promise<Array<{ id: string; type: 'contact' | 'job' }>> {
  const { config, jobnimbus, logger } = ctx;
  const contactTarget = { id: contactJnid, type: 'contact' as const };

  if (config.ATTACH_TARGET === 'contact') return [contactTarget];

  const jobs = await jobnimbus.getRelatedJobs(contactJnid);
  const jobTargets = jobs.map((j) => ({ id: j.jnid, type: 'job' as const }));

  if (config.ATTACH_TARGET === 'both') {
    return [contactTarget, ...jobTargets];
  }

  // ATTACH_TARGET === 'job': prefer related jobs, fall back to the contact.
  if (jobTargets.length === 0) {
    logger.info({ contactJnid }, 'no related jobs; falling back to contact');
    return [contactTarget];
  }
  return jobTargets;
}
