# Start here: a WooCommerce store on Cloudflare, with your MySQL database

**The short version.** This page puts a real WooCommerce store on your own Cloudflare account. The store keeps its data in a MySQL database that you already have, on any provider. You set up Cloudflare in your browser, check your database, then copy and paste the commands below. There is no one-click installer. **Status: pre-alpha (#1077).** Test with it. Do not run a real shop on it yet.

We use two names, as on [Start here](start-here.md):

- **The built-in database option.** The database lives inside Cloudflare. [Start here](start-here.md) installs it.
- **The MySQL option.** Your site uses a MySQL database on a server outside Cloudflare. It is for a real WooCommerce store. This page installs it.

**What it costs:** Workers Paid, $5 a month, plus your MySQL server, which you pay to its provider ([the database server](cost.md#the-mysql-option-the-database-server)).

## 1. How do I install it?

### What you need

- A Cloudflare account on the **Workers Paid** plan ($5 a month).
- A computer with macOS or Linux. On Windows, use WSL and follow the Linux steps.
- A **MySQL server** (MySQL 8, or MariaDB 10.6 or later). Check each line before you start:
  - [ ] It has a **host name**, such as `db.example.com`, not only an IP address. By IP address, every query was about 6 times slower ([approach-a.md](../approach-a.md)).
  - [ ] It accepts **SSL** connections.
  - [ ] Port **3306** is open to [Cloudflare's IP ranges](https://www.cloudflare.com/ips/).
  - [ ] You have a **user and a password**, and an **empty database** for this site.
  - [ ] You know its **cloud and region**, such as `azure:westus2` or `aws:us-east-1`. The site then runs next to it. A site far from its database was 2 to 5 times slower ([full reference](../../deploy/README.md#options)).

  No server yet? Choose a provider in the [onboarding guide](onboarding.md). Or let the install make one on Vultr with `MYSQL=vultr`: that needs a Vultr API key and a domain on Cloudflare, costs $10 a month, and you must remove it when you are done, or it keeps costing money ([full reference](../../deploy/README.md#variant-a-php-in-the-worker-mysql-through-hyperdrive-workers-paid)).

### Step 1: set up Cloudflare (in your browser)

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Buy **Workers Paid**: go to **Workers & Pages**, then **Plans**, and choose **Workers Paid**.
3. While you are in **Workers & Pages**, note your **workers.dev** name. Your site's address uses it.
4. Turn on **R2**: go to **R2 Object Storage** and select **Purchase R2 Plan** (the free tier is enough). Your uploaded images and files are kept there.
5. Make an API token: go to **My Profile**, then **API Tokens**, then **Create Token**, then **Create Custom Token**. Give it these permissions, for your account:
   - Account, **Workers Scripts**, Edit
   - Account, **Workers KV Storage**, Edit
   - Account, **Workers R2 Storage**, Edit
   - Account, **Hyperdrive**, Edit
   - Account, **Account Settings**, Read

   MEASURE: confirm this is the smallest set on the box run.

   Select **Continue to summary**, then **Create Token**. Copy the token now. Cloudflare shows it only once.
6. Copy your **Account ID**. It is on the right side of the **Workers & Pages** page.

### Step 2: install the tools (in your terminal)

You need git, Node.js 22 or later, Terraform 1.5 or later, Python 3, curl, zip, unzip and lsof. The commands are the same as in [Start here, step 2](start-here.md#step-2-install-the-tools-in-your-terminal).

### Step 3: get the code

```sh
git clone https://github.com/skyphusion-labs/pagefeather.git
cd pagefeather
```

### Step 4: make your store

Put your values in place of the dots. Choose a short site name in place of `my-store`: lower-case letters, numbers and dashes. Put your server's cloud and region in place of `azure:westus2`.

```sh
export CLOUDFLARE_API_TOKEN=...
export ACCOUNT_ID=...
VARIANT=a MYSQL=external \
  MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... \
  PLACEMENT=azure:westus2 \
  WOO_ACTIVE=1 MEDIA=1 BENCH=0 NAME=my-store ./deploy/deploy.sh
```

A strict server (Azure, PlanetScale, or MySQL 8 as it comes) also needs `HYPERDRIVE_SQL_MODE=ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION` on that command.

It connects Cloudflare to your database, makes the site in your account, and installs WordPress and WooCommerce into your database. At the end it prints your site's address. MEASURE: the time on the box run.

If the deploy waits with "database not ready yet", Cloudflare cannot reach your server. Check the list in "What you need": the host name, SSL, port 3306, the user and the password. It stops after 10 minutes.

### Step 5: get your admin password

```sh
cd deploy/terraform
terraform workspace select my-store
terraform output -raw admin_password
cd ../..
```

Keep this password safe. The folder `deploy/terraform/terraform.tfstate.d/` holds your site's secrets, your database password among them. Do not share it or put it in git. Only this folder can update or remove the site.

**Other ways to install:** many sites on Workers for Platforms, in the [onboarding guide](onboarding.md); every setting, in the [full reference](../../deploy/README.md).

## 2. How do I get to my site?

- **Your site:** `https://my-store.<your-workers.dev-name>.workers.dev`. Step 4 prints it.
- **wp-admin:** add `/wp-admin/` to that address. The user name is `admin`. The password is the one from step 5.
- **The shop:** add `/shop/`.

The first settings to check are the same as in [Start here](start-here.md#2-how-do-i-get-to-my-site). To update the site later, pull the new code (`git pull`) and run the step 4 command again, with the same values.

## Remove a site

**This deletes the site, and it cannot be undone.** It deletes the site's Worker, its bucket of uploaded images and files, Cloudflare's connection to your database, and the site's secrets.

From the `pagefeather` folder, with the same two `export` lines from step 4 in place:

```sh
NAME=my-store ./deploy/destroy.sh
```

**It does not touch your MySQL database.** Your posts, pages, orders and users stay there. Delete the database yourself when you no longer need it. MEASURE: the last line on the box run.

## 3. What are my limits?

Each line has its measured figure and a link to the evidence.

- **Cost:** $5 a month for Workers Paid, plus your MySQL server ([the database server](cost.md#the-mysql-option-the-database-server)).
- **Not on Workers Free.** The install stops at Free's 10 ms CPU limit ([plan limits](cost.md#plan-limits)).
- **Checkout is slow:** the order step took 4.8 to 6.8 s in our tests ([checkout](limits.md#woocommerce-checkout-is-slow-on-the-mysql-option-1218-1210)).
- **WooCommerce admin and bulk product edits are slow:** a product save takes about 2 to 3 s, and a batch of 5 new products took 6.5 s ([admin](limits.md#woocommerce-admin-screens-and-bulk-product-edits-are-slow-on-the-mysql-option-1078)).
- **A page that is not in the cache yet can be slow:** 9 to 12 s under load in our tests ([the cache MISS](limits.md#on-the-mysql-option-a-guest-product-page-that-was-not-cached-yet-was-slow-1277-open-until-measured-end-to-end)). A cached page runs no PHP.
- **A database query stops after 30 s** ([the query limit](limits.md#a-database-query-is-cut-off-after-30-s-on-the-mysql-option-1359)).
- **You cannot install plugins from wp-admin,** and **email is off until you set it up**, as on the built-in database option ([Start here, limits](start-here.md#3-what-are-my-limits)).

Everything that does not work yet is on the [known limitations](limits.md) page.
