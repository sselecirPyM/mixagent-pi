/** Heuristic guard that keeps the scout's bash usage read-only. */

const WRITE_PATTERNS: RegExp[] = [
	/\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred|install)\b/,
	/\bsed\b[^|;&]*\s-[a-zA-Z]*i/, // sed -i
	/\bperl\b[^|;&]*\s-[a-zA-Z]*i/, // perl -i
	/\d*>{1,2}\s*\S*/, // output redirection (> file, >> file, 2> file)
	/\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|ci|link|publish|run|exec)\b/,
	/\bnpx\b/,
	/\bpip3?\s+(install|uninstall)\b/,
	/\b(apt|apt-get|brew|choco|winget)\s+(install|remove|purge|upgrade|update|uninstall)\b/,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|revert|tag|init|clone|apply|am|rm|mv)\b/,
	/\b(sudo|su|kill|pkill|killall|reboot|shutdown|systemctl|service)\b/,
	/\b(vi|vim|nano|emacs|code)\b/,
	/\bxargs\b[^|;&]*\b(rm|mv|cp|sed)\b/,
];

/** Redirections that never write a file. */
const HARMLESS_REDIRECTS = /\d*>>?\s*\/dev\/null|\d*>&\d|&>\s*\/dev\/null/g;

/** Strip quoted strings so search patterns like rg "a > b" are not mistaken for redirections. */
function stripQuoted(command: string): string {
	return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Returns a reason string if the command looks like it modifies state, otherwise undefined. */
export function findWriteReason(command: string): string | undefined {
	const normalized = stripQuoted(command).replace(HARMLESS_REDIRECTS, " ");
	for (const pattern of WRITE_PATTERNS) {
		const match = normalized.match(pattern);
		if (match) return `"${match[0].trim()}" may modify files or system state`;
	}
	return undefined;
}
