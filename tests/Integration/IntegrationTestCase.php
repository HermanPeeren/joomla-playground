<?php

namespace JoomlaPlayground\Tests\Integration;

use JoomlaPlayground\Tests\Integration\Support\HttpClient;
use JoomlaPlayground\Tests\Integration\Support\Response;
use JoomlaPlayground\Tests\Integration\Support\TestSite;
use PHPUnit\Framework\TestCase;

abstract class IntegrationTestCase extends TestCase
{
    protected static TestSite $site;

    /**
     * Logged in to the administrator, shared by the tests of a class.
     */
    protected static ?HttpClient $admin = null;

    public static function setUpBeforeClass(): void
    {
        static::$site  = TestSite::get();
        static::$admin = null;
    }

    protected static function admin(): HttpClient
    {
        if (static::$admin === null) {
            $client = new HttpClient(static::$site->url);
            $login  = $client->get('administrator/index.php');

            $dashboard = $client->post('administrator/index.php', [
                'username'      => static::$site->username,
                'passwd'        => static::$site->password,
                'option'        => 'com_login',
                'task'          => 'login',
                'return'        => base64_encode('index.php'),
                $login->token() => '1',
            ]);

            if (!str_contains($dashboard->title(), 'Home Dashboard')) {
                throw new \RuntimeException('Administrator login failed: ' . $dashboard->title() . ' ' . implode('; ', $dashboard->errors()));
            }

            static::$admin = $client;
        }

        return static::$admin;
    }

    /**
     * Opens an administrator edit form and submits it as a browser would, with some fields changed.
     *
     * @param  array<string, string>  $values  Field name => value, e.g. 'jform[title]' => 'A title'.
     */
    protected static function submitAdminForm(string $formUrl, string $formId, array $values, string $task): Response
    {
        $admin = static::admin();
        $form  = $admin->get('administrator/index.php?' . $formUrl);
        $pairs = array_values(array_filter(
            $form->formFields($formId),
            static fn (array $pair): bool => !\array_key_exists($pair[0], $values) && $pair[0] !== 'task'
        ));

        foreach ($values + ['task' => $task] as $name => $value) {
            $pairs[] = [$name, (string) $value];
        }

        return $admin->post(ltrim(str_replace(parse_url(static::$site->url, PHP_URL_PATH) ?? '', '', $form->formAction($formId)), '/'), $pairs);
    }

    protected function assertPageOk(Response $response, string $message = ''): void
    {
        $this->assertSame(200, $response->status, $message . ' HTTP status of ' . $response->url);
        $this->assertSame([], $response->errors(), $message . ' errors on ' . $response->url);
    }

    protected static function query(string $sql, array $parameters = []): array
    {
        $statement = static::$site->pdo()->prepare($sql);
        $statement->execute($parameters);

        return $statement->fetchAll();
    }
}
