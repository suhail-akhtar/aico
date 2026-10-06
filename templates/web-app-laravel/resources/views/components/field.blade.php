{{-- A labelled input with its validation message. Props: name, label; any other attribute goes on the <input>. --}}
@props(['name', 'label', 'type' => 'text', 'value' => null])
<div class="mb-4">
    <label for="{{ $name }}" class="label">{{ $label }}</label>
    <input id="{{ $name }}" name="{{ $name }}" type="{{ $type }}"
           @if ($type !== 'password') value="{{ old($name, $value) }}" @endif
           {{ $attributes->class(['input']) }}
           @error($name) aria-invalid="true" aria-describedby="{{ $name }}-error" @enderror>
    @error($name)
        <p id="{{ $name }}-error" class="field-error" role="alert">{{ $message }}</p>
    @enderror
</div>
