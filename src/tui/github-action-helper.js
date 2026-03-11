import { copyToClipboard } from '../clipboard.js';

export default async function githubActionHelper(opts) {
  const {
    item,
    screen,
    db,
    showToast,
    fsImpl,
    spawnImpl,
    copyToClipboard: copyFn = copyToClipboard,
    resolveGithubConfig,
    upsertIssuesFromWorkItems,
    list,
    refreshFromDatabase,
  } = opts;

  // Resolve github config (throws if not configured)
  let githubConfig = null;
  try {
    githubConfig = resolveGithubConfig({});
  } catch (e) {
    showToast('Set githubRepo in config or run: wl github --repo <owner/repo> push');
    return;
  }

  if (item.githubIssueNumber) {
    const url = `https://github.com/${githubConfig.repo}/issues/${item.githubIssueNumber}`;
    try {
      const openUrl = (await import('../utils/open-url.js')).default;
      const ok = await openUrl(url, fsImpl);
      if (!ok) {
        const clipResult = await copyFn(url, { spawn: spawnImpl, writeOsc52: (s) => { try { (screen as any).program?.write?.(s); } catch (_) {} } });
        showToast(clipResult.success ? `URL copied: ${url}` : `Open failed: ${url}`);
      } else {
        showToast('Opening GitHub issue…');
      }
    } catch (e) {
      showToast(`GitHub: ${url}`);
    }
    return;
  }

  // No mapping yet — push this item to GitHub
  showToast('Pushing to GitHub…');
  try {
    screen.render?.();
  } catch (_) {}

  try {
    const comments = db ? db.getCommentsForWorkItem(item.id) : [];
    const { updatedItems, result } = await upsertIssuesFromWorkItems([item], comments, githubConfig);

    if (updatedItems && updatedItems.length > 0) {
      if (db && typeof db.upsertItems === 'function') db.upsertItems(updatedItems);
    }

    try { refreshFromDatabase && refreshFromDatabase((list && list.selected) || 0); } catch (_) {}

    const synced = result && result.syncedItems ? result.syncedItems.find(s => s.id === item.id) : null;
    if (synced?.issueNumber) {
      const url = `https://github.com/${githubConfig.repo}/issues/${synced.issueNumber}`;
      showToast(`Pushed: ${githubConfig.repo}#${synced.issueNumber}`);
      try {
        const openUrl = (await import('../utils/open-url.js')).default;
        const ok = await openUrl(url, fsImpl);
        if (!ok) {
          const clipResult = await copyFn(url, { spawn: spawnImpl, writeOsc52: (s) => { try { if (screen && screen.program && typeof screen.program.write === 'function') screen.program.write(s); } catch (_) {} } });
          if (clipResult.success) showToast('URL copied to clipboard');
        }
      } catch (_) {}
    } else if (result.errors && result.errors.length > 0) {
      showToast(`Push failed: ${result.errors[0]}`);
    } else {
      showToast('Push complete (no changes)');
    }
  } catch (err) {
    showToast(`Push failed: ${err?.message || 'Unknown error'}`);
  }
}
