-- MySQL dump 10.13  Distrib 8.0.39, for Linux (x86_64)
-- A hand-written fixture in the shape of mysqldump 8.0 output (issue #364, variant a).
-- Not a real site. The Action Scheduler tables of WooCommerce, in mysqldump order
-- (actions before groups before logs): 3 pending emails, 1 sent email, 1 pending
-- action of another group, 1 failed email, and 1 log row already there. Empty posts and
-- usermeta tables: dump-to-sqlite.php finds the prefix by options, posts and usermeta.

/*!40101 SET NAMES utf8mb4 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;

DROP TABLE IF EXISTS `wpx_actionscheduler_actions`;
CREATE TABLE `wpx_actionscheduler_actions` (
  `action_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `hook` varchar(191) NOT NULL,
  `status` varchar(20) NOT NULL,
  `scheduled_date_gmt` datetime DEFAULT '0000-00-00 00:00:00',
  `args` varchar(191) DEFAULT NULL,
  `group_id` bigint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`action_id`),
  KEY `status` (`status`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4;
INSERT INTO `wpx_actionscheduler_actions` VALUES (1,'woocommerce_send_queued_transactional_email','pending','2026-11-01 00:00:00','[\"pending\"]',6),(2,'woocommerce_send_queued_transactional_email','pending','2026-11-01 00:01:00',NULL,6),(3,'woocommerce_send_queued_transactional_email','complete','2026-11-01 00:02:00',NULL,6),(4,'woocommerce_run_product_attribute_lookup_update_callback','pending','2026-11-01 00:03:00','[\"pending\"]',3),(5,'woocommerce_send_queued_transactional_email','failed','2026-11-01 00:04:00',NULL,6),(7,'woocommerce_send_queued_transactional_email','pending','2026-11-01 00:05:00',NULL,6);

DROP TABLE IF EXISTS `wpx_actionscheduler_groups`;
CREATE TABLE `wpx_actionscheduler_groups` (
  `group_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `slug` varchar(255) NOT NULL,
  PRIMARY KEY (`group_id`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4;
INSERT INTO `wpx_actionscheduler_groups` VALUES (3,'woocommerce-db-updates'),(6,'woocommerce-emails');

DROP TABLE IF EXISTS `wpx_actionscheduler_logs`;
CREATE TABLE `wpx_actionscheduler_logs` (
  `log_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `action_id` bigint unsigned NOT NULL,
  `message` text NOT NULL,
  `log_date_gmt` datetime DEFAULT '0000-00-00 00:00:00',
  `log_date_local` datetime DEFAULT '0000-00-00 00:00:00',
  PRIMARY KEY (`log_id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4;
INSERT INTO `wpx_actionscheduler_logs` VALUES (1,3,'action complete via WP Cron','2026-11-01 00:02:30','2026-11-01 00:02:30');

DROP TABLE IF EXISTS `wpx_options`;
CREATE TABLE `wpx_options` (
  `option_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `option_name` varchar(191) NOT NULL DEFAULT '',
  `option_value` longtext NOT NULL,
  `autoload` varchar(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (`option_id`),
  UNIQUE KEY `option_name` (`option_name`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4;
INSERT INTO `wpx_options` VALUES (1,'siteurl','https://old.example.com','yes'),(2,'home','https://old.example.com','yes'),(3,'template','storefront','yes'),(4,'stylesheet','storefront','yes');
DROP TABLE IF EXISTS `wpx_posts`;
CREATE TABLE `wpx_posts` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `post_title` text NOT NULL,
  PRIMARY KEY (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS `wpx_usermeta`;
CREATE TABLE `wpx_usermeta` (
  `umeta_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL DEFAULT '0',
  `meta_key` varchar(255) DEFAULT NULL,
  `meta_value` longtext,
  PRIMARY KEY (`umeta_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
-- Dump completed on 2026-11-14  0:00:00
