from urllib.request import urlopen

p = 'https://raw.githubusercontent.com/felixonmars/dnsmasq-china-list/master/'

f = [
    'accelerated-domains.china.conf',
    'apple.china.conf',
    'google.china.conf',
]

z = open('all.hosts', 'w')
z.write('[Hosts]\n\n')

for i in f:
    s = i[:i.rfind('.')]
    a = open(s + '.txt', 'w')
    b = open(s + '.conf', 'w')
    c = open(s + '.hosts', 'w')
    c.write('[Hosts]\n\n')
    for l in urlopen(p + i):
        l = l.decode()
        if l.startswith('server'):
            n = l[l.find('/') + 1:]
            n = n[:n.find('/')]
            a.write(n + '\n')
            b.write(f'DOMAIN-SUFFIX,{n}\n')
            c.write(f'{n} = server:system\n')
            c.write(f'+.{n} = server:system\n')
            z.write(f'{n} = server:system\n')
            z.write(f'+.{n} = server:system\n')
    a.close()
    b.close()
    c.close()

z.close()
