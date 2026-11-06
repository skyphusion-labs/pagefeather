-- MySQL dump 10.13  Distrib 8.0.39, for Linux (x86_64)
--
-- Host: localhost    Database: wordpress
-- ------------------------------------------------------
-- Server version	8.0.39
-- A hand-written fixture in the shape of mysqldump 8.0 output with --hex-blob. Not a real site.

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;

--
-- Table structure for table `wpx_options`
--

DROP TABLE IF EXISTS `wpx_options`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `wpx_options` (
  `option_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `option_name` varchar(191) COLLATE utf8mb4_unicode_520_ci NOT NULL DEFAULT '',
  `option_value` longtext COLLATE utf8mb4_unicode_520_ci NOT NULL,
  `autoload` varchar(20) COLLATE utf8mb4_unicode_520_ci NOT NULL DEFAULT 'yes',
  PRIMARY KEY (`option_id`),
  UNIQUE KEY `option_name` (`option_name`),
  KEY `autoload` (`autoload`)
) ENGINE=InnoDB AUTO_INCREMENT=200 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `wpx_options`
--

LOCK TABLES `wpx_options` WRITE;
/*!40000 ALTER TABLE `wpx_options` DISABLE KEYS */;
INSERT INTO `wpx_options` VALUES (1,'siteurl','https://old.example.com','yes'),(2,'home','https://old.example.com','yes'),(3,'blogname','It\'s a \"test\" site','yes'),(4,'active_plugins','a:2:{i:0;s:19:\"akismet/akismet.php\";i:1;s:27:\"woocommerce/woocommerce.php\";}','yes'),(5,'template','twentytwentyfive','yes'),(6,'stylesheet','twentytwentyfive','yes'),(7,'widget_text','a:1:{i:2;a:1:{s:4:\"text\";s:43:\"See https://old.example.com/about for more.\";}}','yes'),(8,'line_end_semicolon','ends with a semicolon;\nand a newline;','no'),(9,'backslash','C:\\path\\to;','no'),(10,'emoji','Café 😀','no'),(11,'wpx_user_roles','a:1:{s:13:\"administrator\";a:1:{s:4:\"name\";s:13:\"Administrator\";}}','yes');
INSERT INTO `wpx_options` VALUES (12,'raw_newline','a raw newline after a semicolon;
is still one string','no');
/*!40000 ALTER TABLE `wpx_options` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `wpx_posts`
--

DROP TABLE IF EXISTS `wpx_posts`;
CREATE TABLE `wpx_posts` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `post_author` bigint unsigned NOT NULL DEFAULT '0',
  `post_date` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `post_content` longtext COLLATE utf8mb4_unicode_520_ci NOT NULL,
  `post_title` text COLLATE utf8mb4_unicode_520_ci NOT NULL,
  `post_status` varchar(20) COLLATE utf8mb4_unicode_520_ci NOT NULL DEFAULT 'publish',
  `post_name` varchar(200) COLLATE utf8mb4_unicode_520_ci NOT NULL DEFAULT '',
  `guid` varchar(255) COLLATE utf8mb4_unicode_520_ci NOT NULL DEFAULT '',
  `post_type` varchar(20) COLLATE utf8mb4_unicode_520_ci NOT NULL DEFAULT 'post',
  PRIMARY KEY (`ID`),
  KEY `post_name` (`post_name`(191)),
  KEY `type_status_date` (`post_type`,`post_status`,`post_date`,`ID`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;

LOCK TABLES `wpx_posts` WRITE;
INSERT INTO `wpx_posts` VALUES (0,0,'0000-00-00 00:00:00','row with id zero','Zero','draft','zero','','post'),(1,1,'2026-01-02 03:04:05','<!-- wp:paragraph --><p>Hello. <a href=\"https://old.example.com/hello/\">link</a></p><!-- /wp:paragraph -->','Hello world','publish','hello-world','https://old.example.com/?p=1','post'),(2,1,'2026-01-02 03:04:05','line one\r\nline two\ttab','Sample Page','publish','sample-page','https://old.example.com/?page_id=2','page');
INSERT INTO `wpx_posts` VALUES (3,1,'2026-01-03 00:00:00','<img src=\"https://old.example.com/wp-content/uploads/2026/01/a.jpg\">','Image post','publish','image-post','https://old.example.com/?p=3','post');
UNLOCK TABLES;

--
-- Table structure for table `wpx_blobs`
--

DROP TABLE IF EXISTS `wpx_blobs`;
CREATE TABLE `wpx_blobs` (
  `id` int NOT NULL,
  `data` longblob,
  `note` varchar(10) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES `wpx_blobs` WRITE;
INSERT INTO `wpx_blobs` VALUES (1,0x005C27221A,NULL),(2,0x00FF10,'hex'),(3,NULL,''),(4,'',NULL);
UNLOCK TABLES;
--
-- Table structure for table `wpx_usermeta`
--

DROP TABLE IF EXISTS `wpx_usermeta`;
CREATE TABLE `wpx_usermeta` (
  `umeta_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL DEFAULT '0',
  `meta_key` varchar(255) COLLATE utf8mb4_unicode_520_ci DEFAULT NULL,
  `meta_value` longtext COLLATE utf8mb4_unicode_520_ci,
  PRIMARY KEY (`umeta_id`),
  KEY `user_id` (`user_id`),
  KEY `meta_key` (`meta_key`(191))
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;

LOCK TABLES `wpx_usermeta` WRITE;
INSERT INTO `wpx_usermeta` VALUES (1,1,'nickname','admin'),(2,1,'wpx_capabilities','a:1:{s:13:\"administrator\";b:1;}'),(3,1,'wpx_user_level','10'),(4,1,'not_wpx_key','kept'),(5,1,'description','see the wpx_options table and wpx_user_roles');
UNLOCK TABLES;

--
-- A plugin table without the prefix keeps its name.
--

DROP TABLE IF EXISTS `custom_log`;
CREATE TABLE `custom_log` (
  `id` int NOT NULL,
  `msg` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO `custom_log` VALUES (1,'see https://old.example.com/x');
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
-- Dump completed on 2026-11-06  0:00:00
