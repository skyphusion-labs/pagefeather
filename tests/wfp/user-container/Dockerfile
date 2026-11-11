# The container test image for docs/wfp.md item 2: a web server on a KNOWN
# port (8080), so a failure cannot be the port. busybox httpd answers one file.
# Build and push it to the account registry (needs Docker):
#   deploy/wr containers build -p -t wfp-spike-box:1 tests/wfp/user-container
# then use it: CONTAINER_IMAGE=registry.cloudflare.com/<account>/wfp-spike-box:1 BOX_PORT=8080
FROM busybox:1.36.1
RUN mkdir -p /www && echo "container in a user Worker" > /www/index.html
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
