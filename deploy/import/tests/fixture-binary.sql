-- mysqldump without --hex-blob writes _binary. The converter must stop and say so.
CREATE TABLE `wp_options` (`option_id` int NOT NULL, PRIMARY KEY (`option_id`));
CREATE TABLE `wp_posts` (`ID` int NOT NULL, PRIMARY KEY (`ID`));
CREATE TABLE `wp_usermeta` (`umeta_id` int NOT NULL, PRIMARY KEY (`umeta_id`));
CREATE TABLE `b` (`id` int NOT NULL, `data` longblob, PRIMARY KEY (`id`));
INSERT INTO `b` VALUES (1,_binary 'ab');
