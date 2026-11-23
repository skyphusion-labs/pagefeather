# Start here: a WooCommerce store on Cloudflare, with a MySQL database

**The short version.** This page puts a real WooCommerce store on your own Cloudflare account. The store's database is MySQL, on a small server that the install makes for you. You set up Cloudflare, Vultr and a domain in your browser, then copy and paste the commands below. There is no one-click installer. **Status: pre-alpha (#1077).** Test with it. Do not run a real shop on it yet.

We use two names, as on [Start here](start-here.md):

- **The built-in database option.** The database lives inside Cloudflare. [Start here](start-here.md) installs it.
- **The MySQL option.** Your site uses a MySQL database on a server outside Cloudflare. It is for a real WooCommerce store. This page installs it.

**What it costs:** Workers Paid, $5 a month, plus the database server, $10 a month, billed by the hour. The server costs money while it exists, also when nobody visits the site ([the database server](cost.md#the-mysql-option-the-database-server)). To stop the cost, remove the site (below).

## 1. How do I install it?

### What you need

- A Cloudflare account on the **Workers Paid** plan ($5 a month).
- A **domain on Cloudflare**, such as `example.com`. The database server gets a name under it, such as `db-my-store.example.com`. A `workers.dev` name alone is not enough for this option.
- A **Vultr** account. The install makes the database server there.
- A computer with macOS or Linux. On Windows, use WSL and follow the Linux steps.

### Step 1: set up Cloudflare (in your browser)

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Buy **Workers Paid**: go to **Workers & Pages**, then **Plans**, and choose **Workers Paid**.
3. While you are in **Workers & Pages**, note your **workers.dev** name. Your site's address uses it.
4. Turn on **R2**: go to **R2 Object Storage** and select **Purchase R2 Plan** (the free tier is enough).
5. Open your domain, and copy its **Zone ID**. It is on the right side of the domain's **Overview** page.
6. Make an API token: go to **My Profile**, then **API Tokens**, then **Create Token**, then **Create Custom Token**. Give it these permissions:
   - Account, **Workers Scripts**, Edit
   - Account, **Workers KV Storage**, Edit
   - Account, **Workers R2 Storage**, Edit
   - Account, **Hyperdrive**, Edit
   - Account, **Account Settings**, Read
   - Zone, **DNS**, Edit, for your domain

   MEASURE: confirm this is the smallest set on the box run.

   Select **Continue to summary**, then **Create Token**. Copy the token now. Cloudflare shows it only once.
7. Copy your **Account ID**. It is on the right side of the **Workers & Pages** page.

### Step 2: set up Vultr (in your browser)

1. Sign in at [my.vultr.com](https://my.vultr.com).
2. Go to **Account**, then **API**, and select **Enable API**. Copy the **API Key**.
3. Under **Access Control**, check that your computer's IP address may use the key. MEASURE: the default on a new account, on the box run.

### Step 3: install the tools (in your terminal)

You need git, Node.js 22 or later, Terraform 1.5 or later, Python 3, curl, zip, unzip and lsof. The commands are the same as in [Start here, step 2](start-here.md#step-2-install-the-tools-in-your-terminal).

### Step 4: get the code

```sh
git clone https://github.com/skyphusion-labs/pagefeather.git
cd pagefeather
```

### Step 5: make your store

Put your values in place of the dots. Choose a short site name in place of `my-store`: lower-case letters, numbers and dashes. `MYSQL_HOST` is the name the database server gets under your domain.

```sh
export CLOUDFLARE_API_TOKEN=...
export ACCOUNT_ID=...
export VULTR_API_KEY=...
export MYSQL_ZONE_ID=...
export MYSQL_HOST=db-my-store.example.com
VARIANT=a MYSQL=vultr WOO_ACTIVE=1 MEDIA=1 BENCH=0 NAME=my-store ./deploy/deploy.sh
```

It makes the database server (MariaDB, with SSL, open only to Cloudflare), the site in your Cloudflare account, and it installs WordPress and WooCommerce. At the end it prints your site's address. MEASURE: the time on the box run.

### Step 6: get your admin password

```sh
cd deploy/terraform
terraform workspace select my-store
terraform output -raw admin_password
cd ../..
```

Keep this password safe. The folders `deploy/terraform/terraform.tfstate.d/` and `deploy/mysql/terraform.tfstate.d/` hold your site's secrets, the database password among them. Do not share them or put them in git. Only this folder can update or remove the site.

### You already have a MySQL server

Use your server instead of a new one. **We did not run this path on the box run.** Your server needs a host name (not an IP address), SSL, port 3306 open to [Cloudflare's IP ranges](https://www.cloudflare.com/ips/), a user, a password and an empty database. You then need no Vultr account and no domain. Tell the site where the server is, as `PLACEMENT=<aws|gcp|azure>:<region>`, so the site runs next to it. A site far from its database was 2 to 5 times slower ([full reference](../../deploy/README.md#options)).

```sh
VARIANT=a MYSQL=external MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... \
  PLACEMENT=azure:westus2 WOO_ACTIVE=1 MEDIA=1 BENCH=0 NAME=my-store ./deploy/deploy.sh
```

A strict server (Azure, PlanetScale, MySQL 8) also needs `HYPERDRIVE_SQL_MODE=ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`.

**Other ways to install:** the [onboarding guide](onboarding.md) (many sites on Workers for Platforms), and every setting in the [full reference](../../deploy/README.md).

## 2. How do I get to my site?

- **Your site:** `https://my-store.<your-workers.dev-name>.workers.dev`. Step 5 prints it.
- **wp-admin:** add `/wp-admin/` to that address. The user name is `admin`. The password is the one from step 6.
- **The shop:** add `/shop/`.

The first settings to check are the same as in [Start here](start-here.md#2-how-do-i-get-to-my-site). To update the site later, pull the new code (`git pull`) and run the step 5 command again, with the same values.

## Remove a site

**This deletes the site, the database server and everything in them, and it cannot be undone.** It deletes the site's Worker, its bucket of uploaded files, the database server with every post, page, order and user, the server's DNS name, and the site's secrets. Make a copy of your content first if you want to keep it.

From the `pagefeather` folder, with the same `export` lines from step 5 in place:

```sh
NAME=my-store ./deploy/destroy.sh
```

Check that it says it removed the database server. If the server stays, it keeps costing money. MEASURE: the exact line on the box run.

## 3. What are my limits?

Each line has its measured figure and a link to the evidence.

- **Cost:** $5 a month for Workers Paid, plus $10 a month for the database server while it exists ([the database server](cost.md#the-mysql-option-the-database-server)).
- **Not on Workers Free.** The install stops at Free's 10 ms CPU limit ([plan limits](cost.md#plan-limits)).
- **Checkout is slow:** the order step took 4.8 to 6.8 s in our tests ([checkout](limits.md#woocommerce-checkout-is-slow-on-the-mysql-option-1218-1210)).
- **WooCommerce admin and bulk product edits are slow:** a product save takes about 2 to 3 s, and a batch of 5 new products took 6.5 s ([admin](limits.md#woocommerce-admin-screens-and-bulk-product-edits-are-slow-on-the-mysql-option-1078)).
- **A page that is not in the cache yet can be slow:** 9 to 12 s under load in our tests ([the cache MISS](limits.md#on-the-mysql-option-a-guest-product-page-that-was-not-cached-yet-was-slow-1277-open-until-measured-end-to-end)). A cached page runs no PHP.
- **A database query stops after 30 s** ([the query limit](limits.md#a-database-query-is-cut-off-after-30-s-on-the-mysql-option-1359)).
- **You cannot install plugins from wp-admin,** and **email is off until you set it up**, as on the built-in database option ([Start here, limits](start-here.md#3-what-are-my-limits)).

Everything that does not work yet is on the [known limitations](limits.md) page.
