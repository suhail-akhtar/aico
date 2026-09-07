import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack } from 'expo-router';
import { addItem, removeItem, toggleItem, type Item } from '@/src/lib/items';

/**
 * The worked screen: a list you can add to, tick and remove. State lives in
 * the pure functions in src/lib/items.ts; this file only renders and calls.
 */
export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const result = addItem(items, draft);
    if ('error' in result) { setError(result.error); return; }
    setItems(result.items);
    setDraft('');
    setError(null);
  };

  const open = items.filter(i => !i.done).length;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: '__APP_TITLE__' }} />
      <Text style={styles.summary} accessibilityRole="header">
        {items.length === 0 ? 'Nothing yet.' : `${open} open · ${items.length - open} done`}
      </Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="What needs doing?"
          onSubmitEditing={add}
          returnKeyType="done"
          accessibilityLabel="New item"
          testID="new-item"
        />
        <Pressable style={styles.button} onPress={add} accessibilityRole="button" testID="add">
          <Text style={styles.buttonText}>Add</Text>
        </Pressable>
      </View>
      {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
      <FlatList
        data={items}
        keyExtractor={i => i.id}
        ListEmptyComponent={<Text style={styles.empty}>Add the first item above.</Text>}
        renderItem={({ item }) => (
          <View style={styles.item}>
            <Pressable
              onPress={() => setItems(toggleItem(items, item.id))}
              style={[styles.check, item.done && styles.checkDone]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: item.done }}
              accessibilityLabel={item.name}
            >
              {item.done && <Text style={styles.checkMark}>✓</Text>}
            </Pressable>
            <Text style={[styles.name, item.done && styles.nameDone]}>{item.name}</Text>
            <Pressable onPress={() => setItems(removeItem(items, item.id))} accessibilityRole="button" accessibilityLabel={`Delete ${item.name}`}>
              <Text style={styles.delete}>Delete</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12 },
  summary: { fontSize: 14, color: '#5b6270' },
  row: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#e2e6ee', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  button: { backgroundColor: '#2f5df6', borderRadius: 999, paddingHorizontal: 18, justifyContent: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { color: '#b42318', fontSize: 13 },
  empty: { color: '#5b6270', paddingVertical: 24, textAlign: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e6ee' },
  check: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: '#e2e6ee', alignItems: 'center', justifyContent: 'center' },
  checkDone: { backgroundColor: '#2f5df6', borderColor: '#2f5df6' },
  checkMark: { color: '#fff', fontSize: 14 },
  name: { flex: 1, fontSize: 16 },
  nameDone: { textDecorationLine: 'line-through', color: '#5b6270' },
  delete: { color: '#b42318', fontSize: 13 },
});
