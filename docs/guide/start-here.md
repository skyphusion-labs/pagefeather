# Start here: put a WordPress site on Cloudflare

**The short version.** Pagefeather runs WordPress on your own Cloudflare account. Today you install it from a terminal: you set up Cloudflare in 6 steps in your browser, then copy and paste 11 commands on macOS or 15 on Linux. There is no one-click installer for a single site yet ([#401](https://github.com/skyphusion-labs/pagefeather/issues/401)). If you have used cPanel and SSH, or a LAMP server, you can do this. On our test machine the commands took about 2 minutes. This page has three parts: how to install, how to log in, and what the limits are.

We use two names on this page:

- **The built-in database option.** Your site's database lives inside Cloudflare, next to the site. You need no MySQL server. This page installs this option.
- **The MySQL option.** Your site uses a MySQL database that you run somewhere else. It is for a real WooCommerce store. It has [its own Start here](start-here-mysql.md).

## 1. How do I install it?

### What you need

- A Cloudflare account on the **Workers Paid** plan. It costs $5 a month ([plan limits and cost](cost.md#plan-limits)).
- A computer with macOS or Linux. On Windows, use WSL (Windows Subsystem for Linux) and follow the Linux steps.
- A little time for the Cloudflare setup in your browser. The commands then run by themselves.

### Step 1: set up Cloudflare (in your browser)

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up), or sign in.
2. Buy **Workers Paid**: go to **Workers & Pages**, then **Plans**, and choose **Workers Paid**.
3. While you are in **Workers & Pages**, note your **workers.dev** name. Cloudflare asks you to choose one the first time. Your site's address uses it.
4. Turn on **R2**: go to **R2 Object Storage** and select **Purchase R2 Plan** (the free tier is enough). Your uploaded images and files are kept there.
5. Make an API token: go to **My Profile**, then **API Tokens**, then **Create Token**, then **Create Custom Token**. Give it these permissions, for your account:
   - Account, **Workers Scripts**, Edit
   - Account, **Workers R2 Storage**, Edit
   - Account, **Account Settings**, Read

   Select **Continue to summary**, then **Create Token**. Copy the token now. Cloudflare shows it only once.
6. Copy your **Account ID**. It is on the right side of the **Workers & Pages** page.

### Step 2: install the tools (in your terminal)

You need git, Node.js 22 or later, Terraform 1.5 or later, Python 3, curl, zip, unzip and lsof. macOS already has curl, zip, unzip and lsof.

On **macOS**, with [Homebrew](https://brew.sh):

```sh
brew install git node python unzip
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
```

We checked these steps on Linux. The macOS lines are not yet tested on a fresh Mac.

On **Ubuntu or Debian** (and on Windows in WSL):

```sh
sudo apt-get update
sudo apt-get install -y git curl zip unzip lsof python3 gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt-get update && sudo apt-get install -y terraform
```

### Step 3: get the code

```sh
git clone https://github.com/skyphusion-labs/pagefeather.git
cd pagefeather
```

### Step 4: make your site

Put your token and your Account ID in place of the dots. Choose a short site name in place of `my-site`: lower-case letters, numbers and dashes.

```sh
export CLOUDFLARE_API_TOKEN=...
export ACCOUNT_ID=...
VARIANT=b-dosql MEDIA=1 BENCH=0 NAME=my-site ./deploy/deploy.sh
```

It builds WordPress, makes the site in your account, and installs WordPress. At the end it prints your site's address. On our test machine (Linux, 4 CPUs) this took 90 seconds. A slower computer takes longer.

### Step 5: get your admin password

```sh
cd deploy/terraform
terraform workspace select my-site
terraform output -raw admin_password
```

Keep this password safe. The folder `deploy/terraform/terraform.tfstate.d/` holds your site's secrets. Do not share it or put it in git.

**Other ways to install** (one line each):

- **Many sites on one account:** the [site manager](../../deploy/oneclick/README.md), with a Deploy button and no terminal, on Workers for Platforms ($30 a month). See also the [operator guide](operator.md).
- **A real WooCommerce store:** the MySQL option, in [its own Start here](start-here-mysql.md).
- **Move an existing site here:** [import from a mysqldump](../../deploy/import/README.md).
- **Every setting, for engineers:** the [full reference](../../deploy/README.md).

## 2. How do I get to my site?

- **Your site:** `https://my-site.<your-workers.dev-name>.workers.dev`. Step 4 prints it.
- **wp-admin:** add `/wp-admin/` to that address. The user name is `admin`. The password is the one from step 5.

**First settings to check:**

1. **Users, Profile:** set your own email address, and change the password if you want to.
2. **Settings, General:** the site title, the tagline and the time zone.
3. **Settings, Permalinks:** choose **Post name** and select **Save Changes**.
4. **Plugins:** activate the plugins you need from the list (see the limits below).

To use your own domain, deploy again with `CUSTOM_DOMAIN=www.example.com` ([full reference](../../deploy/README.md#options)).

## Remove a site

**This deletes the site and everything in it, and it cannot be undone.** It deletes the site's Worker and its database (every post, page, order and user), the bucket with your uploaded images and files, and the site's secrets. If you want to keep your content, make a copy first ([full reference](../../deploy/README.md#remove-a-site-safely)).

From the `pagefeather` folder you cloned, with the same two `export` lines from step 4 in place:

```sh
NAME=my-site ./deploy/destroy.sh
```

Before it deletes anything, it checks that `my-site` is a site this folder made. After it, your site's address answers "not found".

## 3. What are my limits?

Each line has its measured figure and a link to the evidence.

- **Cost:** $5 a month for Workers Paid. Images and files use R2's free tier, 10 GB a month, then a small metered charge ([plan limits](cost.md#plan-limits)).
- **You cannot install plugins from wp-admin.** The site is code-locked: install, update and edit are off, by design. You can activate and deactivate plugins in wp-admin ([why](from-lamp.md)).
- **You add plugins when you deploy.** Add `PLUGINS="slug slug"` to the step 4 command. You can use the 18 popular plugins that are already checked and pinned ([the list](limits.md#the-18-checked-plugins)). Any other plugin has to be pinned first.
- **Memory decides how many plugins fit, not a count.** A page fails at about 117 to 119 MiB of memory. A WordPress-only site uses about 81 MiB on its heaviest admin page, so it has room for several typical plugins ([how many plugins fit](limits.md#how-many-plugins-fit)).
- **Some big plugins do not fit:** Yoast SEO, All in One SEO and Elementor are over the 64 MiB size limit, and Rank Math with WooCommerce runs out of memory ([how many plugins fit](limits.md#how-many-plugins-fit)).
- **WooCommerce here is a light shop.** Under heavy load the site can reset, and a write in progress can be lost. For a real store, use the MySQL option ([details](limits.md#woocommerce-on-the-built-in-database-option-the-site-resets-under-heavy-load-a-tracked-limit-1022)).
- **Busy traffic:** one site handles about 5 uncached requests a second. Cached pages cost nothing extra ([evidence: what sets the limit](../perf-dosql.md#what-sets-b-dosqls-limit)).
- **A changed page can show its old copy for a while.** A visitor can see the old copy for up to 12 minutes in the worst case. Cloudflare allows 5 cache clears a minute per account after a first burst of 25, and a refused clear is tried again ([evidence](../approach-a-purge.md); [Cloudflare's purge limits](https://developers.cloudflare.com/cache/how-to/purge-cache/), read 2026-11-23).
- **Email is off until you set it up.** A `workers.dev` address sends no email, so password-reset emails do not arrive. You need your own domain, set up for Cloudflare Email Sending, and `MAIL_FROM` ([mail](../../deploy/README.md#mail-for-b-dosql)).
- **On the MySQL option only:** WooCommerce admin screens and bulk product edits are slow ([details](limits.md#woocommerce-admin-screens-and-bulk-product-edits-are-slow-on-the-mysql-option-1078)).

Everything that does not work yet is on the [known limitations](limits.md) page.
