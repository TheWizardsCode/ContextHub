
# <!-- REFACTOR-WL-0MVN4XSCV009QJPO
# smell: simplification
# severity: medium
# description: Use a context manager for opening files
# -->
import re

SRC = 'packages/herdr/src/downtime-worker.ts'
OUT = '.tmpextract'

lines = open(SRC).read().split('\n')  # lines[0] is line 1... careful: split gives last '' element

def text(lo, hi):  # 1-indexed inclusive
    return lines[lo-1:hi]

constants = [
 (231,232), (233,234), (236,241), (243,248), (250,251), (253,260), (262,263), (265,271),
 (273,274), (276,277), (279,279), (280,286), (288,295), (297,310), (312,319), (321,328),
 (330,381), (383,415), (417,479), (481,536), (538,539), (541,542), (544,551), (553,557),
 (559,563), (565,574), (576,577), (579,580), (582,592), (594,598), (600,604), (606,615),
 (617,629), (631,648), (650,654), (656,663), (665,672), (674,684), (686,700), (702,707),
 (709,714), (716,721), (723,728), (730,734), (736,740), (742,752), (754,755), (757,758),
 (849,853), (855,864), (866,881), (883,909), (911,921), (923,923), (924,924), (926,932),
 (934,940), (942,960), (962,971), (973,973), (1126,1137),
]

types = [
 (975,976), (977,1124), (1139,1175), (1177,1185), (1187,1188), (1190,1196),
 (1425,1459), (1526,1539), (1566,1586), (1629,1637),
 (1975,1979), (1981,1986), (1988,2002), (2004,2013), (2015,2024), (2026,2032), (2034,2040), (2042,2045),
 (2132,2140), (2142,2151),
 (2238,2246), (2248,2253), (2255,2277),
 (2387,2397),
 (2428,2428), (2430,2463), (2500,2502), (2503,2503), (2505,2512), (2514,2550),
 (2552,2578), (2580,2620), (2622,2634), (2636,2689), (2691,2698), (2700,2721),
 (2724,2742), (2744,2753), (2755,2772), (2774,2787), (2789,2799),
 (2937,2955), (2957,2958), (2960,2965), (2967,2973),
 (3556,3602), (3604,3619), (3621,3635), (3637,3669), (3671,3785), (3787,3798), (3800,3816),
 (7269,7279), (7281,7292), (7294,7305),
 (7473,7483),
 (7792,7796), (7798,7876),
 (9469,9478),
 (9898,9929),
]

deps = [(3049,3554)]
config = [(7632,7790)]
clamps = [
 (760,770), (10291,10292), (10293,10301), (10303,10311), (10313,10321), (10323,10331),
 (10333,10347), (10349,10364), (10366,10379), (10381,10395), (10397,10410),
]

def dump(name, ranges):
    chunks = []
    for (lo,hi) in ranges:
        t = text(lo,hi)
        chunks.append('\n'.join(t))
    body = '\n\n'.join(chunks)
    # collapse 3+ newlines to 2
    body = re.sub(r'\n{3,}', '\n\n', body)
    open(f'{OUT}/{name}', 'w').write(body + '\n')
    return body

for name, ranges in [('constants', constants), ('types', types), ('deps', deps), ('config', config), ('clamps', clamps)]:
    body = dump(name, ranges)
    print(name, len(body.split('\n')), 'lines')

# Now delete ranges bottom-up from the monolith
allranges = sorted(constants + types + deps + config + clamps, key=lambda r: -r[0])
marked = set()
for (lo,hi) in allranges:
    for i in range(lo, hi+1):
        marked.add(i)

newlines = [ln for idx, ln in enumerate(lines, start=1) if idx not in marked]
mono = '\n'.join(newlines)
mono = re.sub(r'\n{3,}', '\n\n', mono)
# store seam markers for inspection
open(f'{OUT}/mono-remaining.ts', 'w').write(mono + '\n')
print('monolith remaining lines:', len(mono.split('\n')))
