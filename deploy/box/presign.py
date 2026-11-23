"""SigV4 query presigning for R2's S3 API (#1327), stdlib only. The repo signs its own S3 calls with curl --aws-sigv4
(header signing, deploy/wfp/snapshot.py); a box needs URLs it can use with no key at all, so this presigns them.
presign(method, endpoint, bucket, key, access_key, secret_key, expires_s, region="auto", now=None) -> url
Path style: <endpoint>/<bucket>/<key> (bucket None: the endpoint already names it, as AWS's virtual-hosted example).
The secret key is never in the url; the access key id is, as SigV4 requires (X-Amz-Credential)."""
import datetime, hashlib, hmac, urllib.parse


def _q(s, safe="-_.~"):
    return urllib.parse.quote(s, safe=safe)


def _hmac(k, m):
    return hmac.new(k, m.encode(), hashlib.sha256).digest()


def presign(method, endpoint, bucket, key, access_key, secret_key, expires_s, region="auto", now=None):
    t = datetime.datetime.fromtimestamp(now if now is not None else datetime.datetime.now(datetime.timezone.utc).timestamp(), datetime.timezone.utc)
    amz, day = t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y%m%d")
    u = urllib.parse.urlsplit(endpoint.rstrip("/"))
    path = "/" + ((bucket + "/") if bucket else "") + key.lstrip("/")
    cpath = _q(path, safe="/-_.~")
    scope = "%s/%s/s3/aws4_request" % (day, region)
    params = {"X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": "%s/%s" % (access_key, scope), "X-Amz-Date": amz,
              "X-Amz-Expires": str(int(expires_s)), "X-Amz-SignedHeaders": "host"}
    cq = "&".join("%s=%s" % (_q(k), _q(v)) for k, v in sorted(params.items()))
    creq = "\n".join([method, cpath, cq, "host:%s\n" % u.netloc, "host", "UNSIGNED-PAYLOAD"])
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(creq.encode()).hexdigest()])
    k = _hmac(("AWS4" + secret_key).encode(), day)
    for part in (region, "s3", "aws4_request"):
        k = _hmac(k, part)
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    return "%s://%s%s?%s&X-Amz-Signature=%s" % (u.scheme, u.netloc, cpath, cq, sig)
