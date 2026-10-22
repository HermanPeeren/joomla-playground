<?php

namespace JoomlaPlayground\Tests\Integration\Support;

final readonly class Response
{
    public function __construct(
        public int $status,
        public string $body,
        public string $url,
    ) {
    }

    public function title(): string
    {
        return preg_match('#<title>(.*?)</title>#s', $this->body, $match) ? html_entity_decode(trim($match[1])) : '';
    }

    /**
     * Joomla's CSRF token: a hidden input with a 32 character hex name and value 1.
     */
    public function token(): string
    {
        if (!preg_match('/name="([a-f0-9]{32})" value="1"/', $this->body, $match)) {
            throw new \RuntimeException('No CSRF token on ' . $this->url);
        }

        return $match[1];
    }

    /**
     * System messages. Joomla passes them to the page as script options and renders them with JavaScript.
     *
     * @return list<array{type: string, message: string}>
     */
    public function messages(): array
    {
        $messages = [];

        if (!preg_match_all('#<script type="application/json" class="joomla-script-options[^"]*">(.*?)</script>#s', $this->body, $scripts)) {
            return $messages;
        }

        foreach ($scripts[1] as $json) {
            foreach (json_decode($json, true)['joomla.messages'] ?? [] as $group) {
                foreach ($group as $type => $list) {
                    foreach ((array) $list as $message) {
                        $messages[] = ['type' => $type, 'message' => strip_tags($message)];
                    }
                }
            }
        }

        return $messages;
    }

    /**
     * @return string[]
     */
    public function errors(): array
    {
        $errors = array_column(
            array_filter($this->messages(), static fn (array $message): bool => \in_array($message['type'], ['error', 'danger'], true)),
            'message'
        );

        // Uncaught exceptions render Joomla's error page; database errors mention SQLSTATE.
        if (preg_match('/SQLSTATE\[[^\]]*\][^<]{0,300}/', $this->body, $match)) {
            $errors[] = html_entity_decode($match[0]);
        }

        return $errors;
    }

    public function formAction(string $formId): string
    {
        if (!preg_match('/<form[^>]*\bid="' . preg_quote($formId, '/') . '"[^>]*>/', $this->body, $form)
            || !preg_match('/\baction="([^"]*)"/', $form[0], $action)) {
            throw new \RuntimeException('No form #' . $formId . ' on ' . $this->url);
        }

        return html_entity_decode($action[1]);
    }

    /**
     * The fields of a form as the browser would submit them, as name/value pairs.
     *
     * @return list<array{0: string, 1: string}>
     */
    public function formFields(string $formId): array
    {
        $document = new \DOMDocument();
        @$document->loadHTML('<?xml encoding="utf-8"?>' . $this->body);

        $form = (new \DOMXPath($document))->query('//form[@id="' . $formId . '"]')->item(0)
            ?? throw new \RuntimeException('No form #' . $formId . ' on ' . $this->url);

        $pairs = [];
        $xpath = new \DOMXPath($document);

        foreach ($xpath->query('.//input | .//select | .//textarea', $form) as $field) {
            $name = $field->getAttribute('name');

            if ($name === '' || $field->hasAttribute('disabled')) {
                continue;
            }

            switch ($field->nodeName) {
                case 'input':
                    $type = strtolower($field->getAttribute('type') ?: 'text');

                    if (\in_array($type, ['submit', 'button', 'image', 'file', 'reset'], true)) {
                        break;
                    }

                    if (\in_array($type, ['checkbox', 'radio'], true) && !$field->hasAttribute('checked')) {
                        break;
                    }

                    $pairs[] = [$name, $field->hasAttribute('value') ? $field->getAttribute('value') : (\in_array($type, ['checkbox', 'radio'], true) ? 'on' : '')];
                    break;

                case 'textarea':
                    $pairs[] = [$name, $field->textContent];
                    break;

                case 'select':
                    $options  = $xpath->query('.//option', $field);
                    $selected = [];

                    foreach ($options as $option) {
                        if ($option->hasAttribute('selected')) {
                            $selected[] = $option->getAttribute('value');
                        }
                    }

                    if (!$selected && !$field->hasAttribute('multiple') && $options->length) {
                        $selected[] = $options->item(0)->getAttribute('value');
                    }

                    foreach ($selected as $value) {
                        $pairs[] = [$name, $value];
                    }

                    break;
            }
        }

        return $pairs;
    }
}
