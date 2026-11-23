# Plugins and themes: add, update and remove

**The two facts to learn first:**

1. **You add a plugin or a theme when you DEPLOY. You do not upload it in wp-admin.** Every site is code-locked (`DISALLOW_FILE_MODS`): the site's code is a build that is checked and stored, so wp-admin cannot change it ([#458](https://github.com/skyphusion-labs/pagefeather/issues/458)).
2. **A WordPress.org plugin or theme must be PINNED before a deploy can add it.** A pin is one line: the slug, the version, and the SHA-256 of that version's zip. The build downloads only what is pinned, and checks the checksum. The pin lists are [tests/plugins/suite.txt](../../tests/plugins/suite.txt) for plugins and [tests/plugins/themes.txt](../../tests/plugins/themes.txt) for themes, or your own list ([how to add a pin](#add-a-pin)).

A slug that is not pinned stops the deploy before anything changes, with this message:

```
fetch: not pinned in .../themes.txt: astra; refused (pin each one: slug version sha256)
```

**What wp-admin still does:**
- You can activate and deactivate a plugin in **Plugins**.
- You can switch themes in **Appearance > Themes**.
- **Add New**, updates and the plugin and theme editors are off. The Plugins and Themes screens show one line that says to add it to the build.

This page is for all three ways to install a site:

| how you installed | the command you run again |
|---|---|
| The built-in database option ([Start here](start-here.md)) | your step 4 command: `... ./deploy/deploy.sh` |
| The MySQL option ([Start here, MySQL option](start-here-mysql.md)) | your step 4 command: `... ./deploy/deploy.sh` |
| Many sites on Workers for Platforms ([operator guide](operator.md)) | `./deploy/wfp/site update <name>` |

## 1. Add a plugin or theme from WordPress.org

Use the plugin's **slug**: the last part of its address on WordPress.org. For `https://wordpress.org/plugins/classic-editor/`, the slug is `classic-editor`.

**Step 1: check the slug is pinned.**
- The 18 checked plugins are in [The 18 checked plugins](limits.md#the-18-checked-plugins) ([the pin list](../../tests/plugins/suite.txt)).
- The pinned themes are in [the theme pin list](../../tests/plugins/themes.txt).
- Not there? [Add a pin](#add-a-pin) first.

**Step 2: deploy again with the slug.** Add `PLUGINS` or `THEMES` (or both) to the command you used to make the site. Add `REPLACE_INPUTS=1` too: the site remembers the settings it was built with, and refuses a run that changes them unless you say so.

Without `REPLACE_INPUTS=1`, the deploy stops in a few seconds, before anything is built or changed, and names each difference. This is the real output on a new site:

```
refused: this run's inputs differ from the ones site pf1423 recorded (REPLACE_INPUTS=1 replaces them on purpose):
  PLUGINS: recorded '', this run 'classic-editor'
  THEMES: recorded '', this run 'astra'
```

The built-in database option:

```sh
PLUGINS="classic-editor" THEMES="astra" REPLACE_INPUTS=1 \
  VARIANT=b-dosql MEDIA=1 BENCH=0 NAME=my-site ./deploy/deploy.sh
```

The MySQL option (your step 4 command, with the same `MYSQL_...` and `PLACEMENT` values):

```sh
PLUGINS="classic-editor" THEMES="astra" REPLACE_INPUTS=1 \
  VARIANT=a MYSQL=external MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... \
  PLACEMENT=azure:westus2 WOO_ACTIVE=1 MEDIA=1 BENCH=0 NAME=my-store ./deploy/deploy.sh
```

Workers for Platforms:

```sh
PLUGINS="classic-editor" THEMES="astra" REPLACE_INPUTS=1 ./deploy/wfp/site update my-site
```

**Keep every other setting the same.** Pass the plugins and themes the site already has as well. `PLUGINS` is the whole list, not one more. If the refusal lists a difference that you did not mean, fix your command instead of adding `REPLACE_INPUTS=1`.

**Step 3: activate it.** The build puts the plugin or theme on the site, but does not turn it on. In wp-admin, go to **Plugins** and select **Activate**, or go to **Appearance > Themes** and select **Activate**.

## 2. Add your own plugin or theme (a folder or a zip)

Use this for a plugin that is not on WordPress.org, a paid plugin, or your own theme.

1. Put it in a `wp-content` folder on your computer: a plugin in `wp-content/plugins/<name>/`, a theme in `wp-content/themes/<name>/`. A zip must be unzipped first, so that it is a folder (`unzip my-plugin.zip -d ~/my-content/wp-content/plugins/`).
2. Deploy again with `IMPORT_CONTENT` (the path to that `wp-content` folder) and the folder names:

```sh
IMPORT_CONTENT=~/my-content/wp-content IMPORT_PLUGINS="my-plugin" IMPORT_THEMES="my-theme" REPLACE_INPUTS=1 \
  VARIANT=b-dosql MEDIA=1 BENCH=0 NAME=my-site ./deploy/deploy.sh
```

On the MySQL option, use your step 4 command in the same way. On Workers for Platforms, use the same three names before `./deploy/wfp/site update my-site`.

The build refuses a name with `/` or `..`, a name that is not in the folder, and a symbolic link anywhere in the copied folder. It never copies uploads or the drop-in files (`db.php`, `object-cache.php`) ([the rules](../../deploy/import/content.sh)).

## Add a pin

A WordPress.org plugin or theme that is not in the pin lists needs a pin of your own. Keep your pins in your own list file, outside the cloned folder, so the clone stays unchanged. Each line is: the slug, the version, and the SHA-256 of that version's zip from WordPress.org. A line that starts with `#` is a comment.

**Your list REPLACES the default list for that run.** So put in it every slug that the run uses: copy the lines you need from the default list, then add your own.

This example adds Hello Dolly (not in the default list) next to Classic Editor (in it). From the `pagefeather` folder:

```sh
# 1. The current version (it is also on the plugin's WordPress.org page).
v=$(curl -s "https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=hello-dolly" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
echo "$v"

# 2. The SHA-256 of that version's zip.
curl -sfLo pin.zip "https://downloads.wordpress.org/plugin/hello-dolly.$v.zip" && shasum -a 256 pin.zip && rm pin.zip

# 3. Your list: the default line for each pinned plugin you use, then your new line.
grep '^classic-editor ' tests/plugins/suite.txt > ~/my-pins.txt
echo "hello-dolly $v <the sha256 from step 2>" >> ~/my-pins.txt

# 4. Deploy with your list.
SUITE=~/my-pins.txt PLUGINS="classic-editor hello-dolly" REPLACE_INPUTS=1 \
  VARIANT=b-dosql MEDIA=1 BENCH=0 NAME=my-site ./deploy/deploy.sh
```

On the day we tested it, step 1 gave `1.7.2` and step 2 gave `73847b0868f335d597c77a95aaa8c18eb1656c4b646e492ed1d65752d3236427`.

`SUITE` changes only the plugin list. The themes still come from the default theme list. `SUITE` and `THEME_SUITE` are not remembered by the site, so you pass them again on every deploy that uses them.

For a theme, use the same steps with `https://api.wordpress.org/themes/info/1.2/?action=theme_information&request%5Bslug%5D=<slug>`, the zip at `https://downloads.wordpress.org/theme/<slug>.<version>.zip`, `tests/plugins/themes.txt`, and `THEME_SUITE` instead of `SUITE`.

**One run reads ONE plugin list and ONE theme list.** If your site already uses a list of its own (it was deployed with `SUITE` or `THEME_SUITE`), a pin in the default list does not join it by itself. Make one file that holds both, the site's lines and the new pin line, as in step 3 above.

([How the check works](../../tests/plugins/fetch.sh).)

## 3. Update a plugin or theme

A plugin or theme changes only when the build changes:

- **A pinned WordPress.org plugin:** change its version and SHA-256 in your pin list (above), then deploy again with the same `PLUGINS`. The plugin's settings are kept: they are in the database.
- **Your own copy:** replace the folder under your `wp-content`, then deploy again with the same `IMPORT_` names.

WordPress shows no update notices for these plugins, because the site cannot update itself.

## 4. Remove a plugin or theme

1. **First, in wp-admin, deactivate the plugin** (or switch to another theme). This is important. If WordPress loads an admin page while an active plugin is missing, it turns that plugin off in the database. It does this on its own, and it does not turn the plugin on again when you put the code back.
2. Deploy again without it: the same command, with that slug taken out of `PLUGINS` or `THEMES` (or that name out of `IMPORT_PLUGINS` or `IMPORT_THEMES`), and `REPLACE_INPUTS=1`.

```sh
REPLACE_INPUTS=1 VARIANT=b-dosql MEDIA=1 BENCH=0 NAME=my-site ./deploy/deploy.sh
```

That example removes all of them, because the command has no `PLUGINS` or `THEMES`. To keep some, list only the ones you keep. The deploy names what it removes:

```
REPLACE_INPUTS=1: the recorded inputs are replaced:
  PLUGINS: recorded 'classic-editor hello-dolly', this run ''
  THEMES: recorded 'astra', this run ''
```

## 5. Check that it worked

- **In wp-admin:** **Plugins** lists the plugin. **Appearance > Themes** lists the theme.
- **From your terminal:** each deploy prints one `fetch:` line for each plugin and theme it puts in, for example `fetch: plugin classic-editor 1.7.0 (136 KiB)`.
- **The build id** is in `spikes/b2-wordpress/build/build-id.js` after a deploy (`cat spikes/b2-wordpress/build/build-id.js`). When the build has plugins or themes, the id ends in `-c` and 8 letters and digits, and that part changes when the set changes. In our test the id ended in `-c882e96a7` after the first add, `-c3fc5dce6` after Hello Dolly was added, and had no `-c` part after everything was removed.
- **After a remove:** the plugin is not in the Plugins list, and the theme is not in Themes.

## 6. Limits

- **Memory decides how many plugins fit, not a count.** Some big plugins do not fit at all: see [How many plugins fit](limits.md#how-many-plugins-fit).
- **The site code has a size limit** of 64 MiB (the deploy stops at 62 MiB). A plugin that makes the build too big is refused when you deploy.
- **Only plugins and themes that are pinned, or that you copy in yourself.** The build never fetches a plugin that has no checksum.
- **A child theme needs its parent** in the same build. The build refuses a child theme without it.
- More limits are on the [known limitations](limits.md) page.

## How this page was tested

**Tested 2026-11-23** on a new site made with the [Start here](start-here.md) step 4 command (the built-in database option, main `0914260`, a throwaway named `pf1423`, since deleted). We ran, in order: the add without `REPLACE_INPUTS=1` (refused in 2 seconds, nothing changed), the add of Classic Editor and Astra, the add of Hello Dolly from a list file of our own, and the remove. After each one we checked the Plugins and Themes lists as the admin, and turned Classic Editor on and off.

**Not tested live on this page:** the MySQL option and Workers for Platforms commands, and `IMPORT_CONTENT`. They use the same settings, read from [deploy/deploy.sh](../../deploy/deploy.sh), [deploy/wfp/README.md](../../deploy/wfp/README.md) and [deploy/import/content.sh](../../deploy/import/content.sh).
