CREATE TABLE IF NOT EXISTS `#__playgroundtest_items` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL DEFAULT '',
  `state` tinyint NOT NULL DEFAULT 1,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_state` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 DEFAULT COLLATE=utf8mb4_unicode_ci;

INSERT INTO `#__playgroundtest_items` (`title`, `created`) VALUES ('First item', NOW());
