import { mayHaveWritten } from './object-error.mjs';

// A path with a repeated slash (https://host//checkout-link) is not the
// checkout-link route here. nginx and Apache merge those slashes before the
// app. Send the browser to the merged path so WordPress sees that path.
// Only GET, HEAD and OPTIONS (#1005). Any other method is passed through:
// a 301 is followed as GET and the body is lost. Stock WordPress trims the
// path itself (class-wp.php). Callers that omit the method still get the
// target, which is the #912 browser case. The gateway always passes req.method.
export function collapsedSlashRedirect(urlString, method) {
	let url;
	try {
		url = new URL(urlString);
	} catch {
		return null;
	}
	if (!url.pathname.includes('//')) return null;
	if (method !== undefined && mayHaveWritten(method)) return null;
	const collapsed = url.pathname.replace(/\/{2,}/g, '/');
	if (collapsed === url.pathname) return null;
	url.pathname = collapsed || '/';
	return url.toString();
}
