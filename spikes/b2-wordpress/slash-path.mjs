// A path with a repeated slash (https://host//checkout-link) is not the
// checkout-link route here. nginx and Apache merge those slashes before the
// app. Send the browser to the merged path so WordPress sees that path.
export function collapsedSlashRedirect(urlString) {
	let url;
	try {
		url = new URL(urlString);
	} catch {
		return null;
	}
	if (!url.pathname.includes('//')) return null;
	const collapsed = url.pathname.replace(/\/{2,}/g, '/');
	if (collapsed === url.pathname) return null;
	url.pathname = collapsed || '/';
	return url.toString();
}
