-- A multisite dump: the converter must refuse it.
CREATE TABLE `wp_options` (`option_id` int NOT NULL, PRIMARY KEY (`option_id`));
CREATE TABLE `wp_posts` (`ID` int NOT NULL, PRIMARY KEY (`ID`));
CREATE TABLE `wp_usermeta` (`umeta_id` int NOT NULL, PRIMARY KEY (`umeta_id`));
CREATE TABLE `wp_blogs` (`blog_id` int NOT NULL, PRIMARY KEY (`blog_id`));
