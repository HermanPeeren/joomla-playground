<?php

namespace JoomlaPlayground\Tests\Integration\Support;

/**
 * Minimal browser: keeps cookies, follows redirects, posts forms.
 */
final class HttpClient
{
    private string $cookieFile;

    public function __construct(private readonly string $baseUrl)
    {
        $this->cookieFile = tempnam(sys_get_temp_dir(), 'jpg-cookies-');
    }

    public function __destruct()
    {
        @unlink($this->cookieFile);
    }

    public function get(string $path): Response
    {
        return $this->request($path);
    }

    /**
     * @param  array<string, mixed>|list<array{0: string, 1: string}>  $fields  Named fields, or name/value pairs (for repeated names).
     */
    public function post(string $path, array $fields): Response
    {
        return $this->request($path, array_is_list($fields) ? self::encodePairs($fields) : http_build_query($fields));
    }

    private function request(string $path, ?string $body = null): Response
    {
        $curl = curl_init($this->baseUrl . '/' . ltrim($path, '/'));

        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_COOKIEFILE     => $this->cookieFile,
            CURLOPT_COOKIEJAR      => $this->cookieFile,
            CURLOPT_TIMEOUT        => 120,
        ]);

        if ($body !== null) {
            curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
        }

        $content = curl_exec($curl);

        if ($content === false) {
            throw new \RuntimeException('Request failed: ' . curl_error($curl));
        }

        $response = new Response(
            curl_getinfo($curl, CURLINFO_RESPONSE_CODE),
            $content,
            curl_getinfo($curl, CURLINFO_EFFECTIVE_URL)
        );

        // Store the cookies now; the jar is otherwise only written when the handle is destroyed.
        curl_setopt($curl, CURLOPT_COOKIELIST, 'FLUSH');

        return $response;
    }

    /**
     * @param  list<array{0: string, 1: string}>  $pairs
     */
    private static function encodePairs(array $pairs): string
    {
        return implode('&', array_map(static fn (array $pair): string => rawurlencode($pair[0]) . '=' . rawurlencode($pair[1]), $pairs));
    }
}
